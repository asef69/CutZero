"""Turns an uploaded SVG into millimetre polygons the engine can nest.

Handles <path> (all commands, including arcs), <polygon>, <polyline>, <rect>, <circle>, <ellipse>,
nested <g> transforms and physical units. Bezier and arc segments are sampled, simplified with
Douglas-Peucker, and rings nested inside another ring become holes of that piece.
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterator

from defusedxml import ElementTree as SafeET  # Blocks entity-expansion and external-entity attacks.

from .geometry_utils import (
    Point,
    Ring,
    adaptive_steps,
    cubic,
    dedupe,
    ensure_ccw,
    ensure_cw,
    point_in_ring,
    quadratic,
    signed_area,
    simplify_to_budget,
)

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

UNIT_TO_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "pt": 25.4 / 72, "pc": 25.4 / 6, "px": 25.4 / 96, "": 1.0}
MIN_RING_AREA_MM2 = 1.0
MAX_PIECES = 300


class SvgParseError(ValueError):
    pass


_NUMBER = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
_NUMBER_RE = re.compile(_NUMBER)
_PATH_TOKEN_RE = re.compile(rf"([MmLlHhVvCcSsQqTtAaZz])|({_NUMBER})")
_TRANSFORM_RE = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")


def _mul(a: Matrix, b: Matrix) -> Matrix:
    return (
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    )


def _apply(m: Matrix, p: Point) -> Point:
    return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def _parse_transform(text: str | None) -> Matrix:
    result = IDENTITY
    if not text:
        return result
    for name, args in _TRANSFORM_RE.findall(text):
        v = [float(n) for n in _NUMBER_RE.findall(args)]
        m = IDENTITY
        if name == "matrix" and len(v) == 6:
            m = (v[0], v[1], v[2], v[3], v[4], v[5])
        elif name == "translate" and v:
            m = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0.0)
        elif name == "scale" and v:
            m = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate" and v:
            r = math.radians(v[0])
            c, s = math.cos(r), math.sin(r)
            m = (c, s, -s, c, 0, 0)
            if len(v) == 3:
                m = _mul(_mul((1, 0, 0, 1, v[1], v[2]), m), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == "skewX" and v:
            m = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == "skewY" and v:
            m = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        result = _mul(result, m)
    return result


def _length_mm(text: str | None) -> float | None:
    if not text:
        return None
    match = re.fullmatch(rf"\s*({_NUMBER})\s*([a-zA-Z%]*)\s*", text)
    if not match or match.group(2) == "%":
        return None
    unit = match.group(2).lower()
    return float(match.group(1)) * UNIT_TO_MM[unit] if unit in UNIT_TO_MM else None


def _arc_points(p0: Point, rx: float, ry: float, angle: float, large: bool, sweep: bool, p1: Point) -> Ring:
    """Samples an elliptical arc using the SVG spec's endpoint-to-centre conversion."""
    if rx == 0 or ry == 0:
        return [p1]
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(angle % 360)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1 = cp * dx + sp * dy
    y1 = -sp * dx + cp * dy
    scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if scale > 1:
        rx *= math.sqrt(scale)
        ry *= math.sqrt(scale)
    num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    factor = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        factor = -factor
    cx1 = factor * rx * y1 / ry
    cy1 = -factor * ry * x1 / rx
    cx = cp * cx1 - sp * cy1 + (p0[0] + p1[0]) / 2
    cy = sp * cx1 + cp * cy1 + (p0[1] + p1[1]) / 2
    start = math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
    end = math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx)
    delta = end - start
    if sweep and delta < 0:
        delta += 2 * math.pi
    elif not sweep and delta > 0:
        delta -= 2 * math.pi
    steps = adaptive_steps(abs(delta) * max(rx, ry))
    out: Ring = []
    for i in range(1, steps + 1):
        t = start + delta * i / steps
        ex, ey = rx * math.cos(t), ry * math.sin(t)
        out.append((cp * ex - sp * ey + cx, sp * ex + cp * ey + cy))
    out[-1] = p1
    return out


def _path_rings(d: str) -> list[Ring]:
    tokens: list[str] = [m.group(0) for m in _PATH_TOKEN_RE.finditer(d)]
    rings: list[Ring] = []
    current: Ring = []
    i = 0
    cmd = ""
    pos: Point = (0.0, 0.0)
    start: Point = (0.0, 0.0)
    last_cubic: Point | None = None
    last_quad: Point | None = None

    def number() -> float:
        nonlocal i
        if i >= len(tokens) or tokens[i].isalpha():
            raise SvgParseError("Malformed path data: expected a number.")
        value = float(tokens[i])
        i += 1
        return value

    def flag() -> bool:
        return number() != 0

    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd in "Zz":
                if current:
                    rings.append(current)
                current = []
                pos = start
                last_cubic = last_quad = None
                continue
        elif cmd == "":
            raise SvgParseError("Path data must start with a move command.")
        elif cmd in "Zz":
            raise SvgParseError("Malformed path data after close command.")

        rel = cmd.islower()
        op = cmd.upper()
        base = pos if rel else (0.0, 0.0)

        if op == "M":
            x, y = number() + base[0], number() + base[1]
            if current:
                rings.append(current)
            pos = start = (x, y)
            current = [pos]
            cmd = "l" if rel else "L"  # Further coordinate pairs are implicit line-tos.
            last_cubic = last_quad = None
            continue
        if not current:
            current = [pos]
            start = pos

        if op == "L":
            pos = (number() + base[0], number() + base[1])
            current.append(pos)
            last_cubic = last_quad = None
        elif op == "H":
            pos = (number() + base[0], pos[1])
            current.append(pos)
            last_cubic = last_quad = None
        elif op == "V":
            pos = (pos[0], number() + base[1])
            current.append(pos)
            last_cubic = last_quad = None
        elif op in "CS":
            if op == "C":
                c1 = (number() + base[0], number() + base[1])
            else:
                c1 = (2 * pos[0] - last_cubic[0], 2 * pos[1] - last_cubic[1]) if last_cubic else pos
            c2 = (number() + base[0], number() + base[1])
            end = (number() + base[0], number() + base[1])
            estimate = math.dist(pos, c1) + math.dist(c1, c2) + math.dist(c2, end)
            current.extend(cubic(pos, c1, c2, end, adaptive_steps(estimate)))
            pos, last_cubic, last_quad = end, c2, None
        elif op in "QT":
            if op == "Q":
                c = (number() + base[0], number() + base[1])
            else:
                c = (2 * pos[0] - last_quad[0], 2 * pos[1] - last_quad[1]) if last_quad else pos
            end = (number() + base[0], number() + base[1])
            estimate = math.dist(pos, c) + math.dist(c, end)
            current.extend(quadratic(pos, c, end, adaptive_steps(estimate)))
            pos, last_quad, last_cubic = end, c, None
        elif op == "A":
            rx, ry, angle = number(), number(), number()
            large, sweep = flag(), flag()
            end = (number() + base[0], number() + base[1])
            current.extend(_arc_points(pos, rx, ry, angle, large, sweep, end))
            pos = end
            last_cubic = last_quad = None
    if current:
        rings.append(current)
    return rings


def _ellipse_ring(cx: float, cy: float, rx: float, ry: float) -> Ring:
    steps = max(16, min(72, int(2 * math.pi * max(rx, ry) / 3)))
    return [
        (cx + rx * math.cos(2 * math.pi * i / steps), cy + ry * math.sin(2 * math.pi * i / steps))
        for i in range(steps)
    ]


def _shape_rings(tag: str, el: Any) -> list[Ring]:
    def num(name: str) -> float:
        value = el.get(name)
        if value is None:
            return 0.0
        found = _NUMBER_RE.search(value)
        return float(found.group(0)) if found else 0.0

    if tag == "path":
        return _path_rings(el.get("d", ""))
    if tag in ("polygon", "polyline"):
        v = [float(n) for n in _NUMBER_RE.findall(el.get("points", ""))]
        return [[(v[i], v[i + 1]) for i in range(0, len(v) - 1, 2)]]
    if tag == "rect":
        x, y, w, h = num("x"), num("y"), num("width"), num("height")
        rx = num("rx") or num("ry")
        ry = num("ry") or num("rx")
        if rx <= 0:
            return [[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]]
        rx, ry = min(rx, w / 2), min(ry, h / 2)
        ring: Ring = []
        for cx, cy, a0 in (
            (x + w - rx, y + ry, -90),
            (x + w - rx, y + h - ry, 0),
            (x + rx, y + h - ry, 90),
            (x + rx, y + ry, 180),
        ):
            ring.extend(
                (cx + rx * math.cos(math.radians(a0 + 90 * i / 6)), cy + ry * math.sin(math.radians(a0 + 90 * i / 6)))
                for i in range(7)
            )
        return [ring]
    if tag == "circle":
        r = num("r")
        return [_ellipse_ring(num("cx"), num("cy"), r, r)]
    if tag == "ellipse":
        return [_ellipse_ring(num("cx"), num("cy"), num("rx"), num("ry"))]
    return []


def _walk(el: Any, matrix: Matrix) -> Iterator[tuple[str, Ring]]:
    tag = el.tag.split("}")[-1] if isinstance(el.tag, str) else ""
    if tag in ("defs", "clipPath", "mask", "symbol", "pattern", "marker", "metadata", "title", "desc", "style"):
        return
    local = _mul(matrix, _parse_transform(el.get("transform")))
    name = el.get("id") or el.get("{http://www.inkscape.org/namespaces/inkscape}label") or tag
    for ring in _shape_rings(tag, el):
        yield name, [_apply(local, p) for p in ring]
    for child in list(el):
        yield from _walk(child, local)


def _root_scale(root: Any) -> Matrix:
    """Maps user units to millimetres. Without physical units, 1 user unit is taken as 1 mm."""
    box = [float(n) for n in _NUMBER_RE.findall(root.get("viewBox", ""))]
    width_mm = _length_mm(root.get("width"))
    height_mm = _length_mm(root.get("height"))
    has_units = bool(re.search(r"[a-zA-Z]", root.get("width", "") or ""))
    if len(box) == 4 and box[2] > 0 and box[3] > 0:
        sx = width_mm / box[2] if width_mm and has_units else 1.0
        sy = height_mm / box[3] if height_mm and has_units else sx
        return (sx, 0, 0, sy, -box[0] * sx, -box[1] * sy)
    if has_units and root.get("width"):
        # No viewBox: user units are CSS pixels by definition.
        s = UNIT_TO_MM["px"]
        return (s, 0, 0, s, 0, 0)
    return IDENTITY


def parse_svg(data: bytes, epsilon_mm: float = 0.25, max_vertices: int = 80) -> list[dict[str, Any]]:
    try:
        root = SafeET.fromstring(data)
    except Exception as exc:  # defusedxml raises several distinct error types
        raise SvgParseError(f"Not a readable SVG file: {exc}") from exc
    if not isinstance(root.tag, str) or root.tag.split("}")[-1] != "svg":
        raise SvgParseError("The file's root element is not <svg>.")

    collected: list[tuple[str, Ring]] = []
    for name, ring in _walk(root, _root_scale(root)):
        clean = dedupe(ring, 1e-4)
        if len(clean) < 3 or abs(signed_area(clean)) < MIN_RING_AREA_MM2:
            continue
        simplified = simplify_to_budget(clean, epsilon_mm, max_vertices)
        if len(simplified) >= 3 and abs(signed_area(simplified)) >= MIN_RING_AREA_MM2:
            collected.append((name, simplified))
    if not collected:
        raise SvgParseError("No closed shapes were found. Supported: path, polygon, polyline, rect, circle, ellipse.")

    # Containment depth decides the role: even depth starts a new piece, odd depth is a hole in its parent.
    collected.sort(key=lambda item: -abs(signed_area(item[1])))
    depth = [0] * len(collected)
    parent = [-1] * len(collected)
    for i, (_, ring) in enumerate(collected):
        for j in range(i):
            if point_in_ring(ring[0], collected[j][1]):
                depth[i] += 1
                parent[i] = j

    pieces: dict[int, dict[str, Any]] = {}
    for i, (name, ring) in enumerate(collected):
        if depth[i] % 2 == 0:
            pieces[i] = {"name": name, "outer": ensure_ccw(ring), "holes": []}
    for i, (_, ring) in enumerate(collected):
        if depth[i] % 2 == 1 and parent[i] in pieces:
            pieces[parent[i]]["holes"].append(ensure_cw(ring))
    if len(pieces) > MAX_PIECES:
        raise SvgParseError(f"This file has {len(pieces)} pieces; the limit is {MAX_PIECES}.")

    out: list[dict[str, Any]] = []
    used: dict[str, int] = {}
    for index, piece in enumerate(pieces.values()):
        min_x = min(p[0] for p in piece["outer"])
        min_y = min(p[1] for p in piece["outer"])
        shift = lambda ring: [[round(x - min_x, 4), round(y - min_y, 4)] for x, y in ring]  # noqa: E731
        outer, holes = shift(piece["outer"]), [shift(h) for h in piece["holes"]]
        area = abs(signed_area(outer)) - sum(abs(signed_area(h)) for h in holes)
        base = piece["name"] or "piece"
        used[base] = used.get(base, 0) + 1
        label = base if used[base] == 1 else f"{base} {used[base]}"
        out.append({"id": index, "name": label, "outer": outer, "holes": holes, "area_mm2": round(area, 2)})
    return out
