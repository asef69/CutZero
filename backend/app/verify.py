"""Independent layout verification, in pure Python.

The C++ engine checks its own layouts, but a judge should not have to trust that. This module
shares no code with it: it rebuilds every piece from the raw input polygons and the reported
rotation and translation, then re-derives clearance from first principles.
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Sequence

Point = tuple[float, float]


def _transform(ring: Iterable[Sequence[float]], deg: float, tx: float, ty: float) -> list[Point]:
    rad = math.radians(deg)
    c, s = math.cos(rad), math.sin(rad)
    return [(c * x - s * y + tx, s * x + c * y + ty) for x, y in ring]


def _point_segment_sq(p: Point, a: Point, b: Point) -> float:
    vx, vy = b[0] - a[0], b[1] - a[1]
    wx, wy = p[0] - a[0], p[1] - a[1]
    length = vx * vx + vy * vy
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / length)) if length > 0.0 else 0.0
    dx, dy = wx - t * vx, wy - t * vy
    return dx * dx + dy * dy


def _segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool:
    def side(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return (side(a, b, c) > 0) != (side(a, b, d) > 0) and (side(c, d, a) > 0) != (side(c, d, b) > 0)


def _segment_distance(a: Point, b: Point, c: Point, d: Point) -> float:
    if _segments_cross(a, b, c, d):
        return 0.0
    return math.sqrt(
        min(
            _point_segment_sq(a, c, d),
            _point_segment_sq(b, c, d),
            _point_segment_sq(c, a, b),
            _point_segment_sq(d, a, b),
        )
    )


def _in_ring(p: Point, ring: Sequence[Point]) -> bool:
    x, y = p
    inside = False
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) / (y1 - y0) * (x1 - x0):
            inside = not inside
    return inside


class _World:
    __slots__ = ("id", "name", "outer", "holes", "edges", "min_x", "min_y", "max_x", "max_y")

    def __init__(self, piece: dict[str, Any], place: dict[str, Any]) -> None:
        deg, tx, ty = place["rotation_deg"], place["tx"], place["ty"]
        self.id = piece["id"]
        self.name = piece.get("name", str(self.id))
        self.outer = _transform(piece["outer"], deg, tx, ty)
        self.holes = [_transform(h, deg, tx, ty) for h in piece.get("holes", [])]
        self.edges: list[tuple[Point, Point]] = []
        for ring in (self.outer, *self.holes):
            self.edges.extend((ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring)))
        xs = [p[0] for p in self.outer]
        ys = [p[1] for p in self.outer]
        self.min_x, self.max_x, self.min_y, self.max_y = min(xs), max(xs), min(ys), max(ys)

    def solid_contains(self, p: Point) -> bool:
        return _in_ring(p, self.outer) and not any(_in_ring(p, h) for h in self.holes)


def _pair_distance(a: _World, b: _World, stop_below: float) -> float:
    if a.solid_contains(b.outer[0]) or b.solid_contains(a.outer[0]):
        return 0.0
    best = math.inf
    for p, q in a.edges:
        lo_x, hi_x = (p[0], q[0]) if p[0] < q[0] else (q[0], p[0])
        lo_y, hi_y = (p[1], q[1]) if p[1] < q[1] else (q[1], p[1])
        if hi_x < b.min_x - best or lo_x > b.max_x + best or hi_y < b.min_y - best or lo_y > b.max_y + best:
            continue
        for r, s in b.edges:
            if max(r[0], s[0]) < lo_x - best or min(r[0], s[0]) > hi_x + best:
                continue
            if max(r[1], s[1]) < lo_y - best or min(r[1], s[1]) > hi_y + best:
                continue
            d = _segment_distance(p, q, r, s)
            if d < best:
                best = d
                if best < stop_below:
                    return best
    return best


def verify_layout(
    pieces: Sequence[dict[str, Any]],
    layout: Sequence[dict[str, Any]],
    roll_width_mm: float,
    kerf_mm: float,
    tolerance_mm: float = 1e-6,
) -> dict[str, Any]:
    by_id = {p["id"]: p for p in pieces}
    placed = [_World(by_id[item["id"]], item) for item in layout]

    missing = sorted(set(by_id) - {item["id"] for item in layout})
    duplicates = len(layout) - len({item["id"] for item in layout})
    problems: list[str] = []
    if missing:
        problems.append(f"{len(missing)} piece(s) missing from layout")
    if duplicates:
        problems.append(f"{duplicates} piece(s) placed more than once")

    min_clearance = math.inf
    pairs_checked = 0
    # A pair's bbox gap bounds its clearance from below, so far-apart pairs can be skipped outright.
    search = kerf_mm + 25.0

    for piece in placed:
        wall = min(piece.min_x, piece.min_y, roll_width_mm - piece.max_y)
        min_clearance = min(min_clearance, wall)
        if wall < kerf_mm - tolerance_mm:
            problems.append(f"'{piece.name}' is {wall:.3f} mm from the roll edge")

    placed_sorted = sorted(placed, key=lambda p: p.min_x)
    for i, a in enumerate(placed_sorted):
        for b in placed_sorted[i + 1 :]:
            if b.min_x - a.max_x > search:
                break
            if b.min_y - a.max_y > search or a.min_y - b.max_y > search:
                continue
            pairs_checked += 1
            d = _pair_distance(a, b, kerf_mm - tolerance_mm)
            min_clearance = min(min_clearance, d)
            if d < kerf_mm - tolerance_mm:
                problems.append(f"'{a.name}' and '{b.name}' are {d:.3f} mm apart")

    return {
        "valid": not problems,
        "verifier": "independent pure-Python exact geometry check",
        "pieces_checked": len(placed),
        "pairs_checked": pairs_checked,
        "min_clearance_mm": None if math.isinf(min_clearance) else min_clearance,
        "kerf_mm": kerf_mm,
        "problems": problems[:20],
    }
