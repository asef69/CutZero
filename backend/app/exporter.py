"""Production outputs: a scaled nested SVG marker and a G00/G01 CNC toolpath."""

from __future__ import annotations

import math
from typing import Any, Sequence
from xml.sax.saxutils import escape, quoteattr

Point = tuple[float, float]


def world_rings(piece: dict[str, Any], place: dict[str, Any]) -> tuple[list[Point], list[list[Point]]]:
    rad = math.radians(place["rotation_deg"])
    c, s = math.cos(rad), math.sin(rad)
    tx, ty = place["tx"], place["ty"]

    def transform(ring: Sequence[Sequence[float]]) -> list[Point]:
        return [(c * x - s * y + tx, s * x + c * y + ty) for x, y in ring]

    return transform(piece["outer"]), [transform(h) for h in piece.get("holes", [])]


def _ring_path(ring: Sequence[Point]) -> str:
    head = f"M{ring[0][0]:.3f} {ring[0][1]:.3f}"
    return head + "".join(f"L{x:.3f} {y:.3f}" for x, y in ring[1:]) + "Z"


def export_svg(job: dict[str, Any]) -> str:
    """The roll is drawn 1:1 in millimetres, so the file opens at true size in CAD tools."""
    width = job["roll_width_mm"]
    length = job["optimized_length_mm"]
    by_id = {p["id"]: p for p in job["pieces"]}
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f"<!-- CutZero nested marker: {escape(job['name'])} | {length:.1f} mm x {width:.1f} mm | "
        f"utilization {job['optimized_utilization_pct']:.2f}% | kerf {job['kerf_mm']} mm -->",
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{length:.3f}mm" height="{width:.3f}mm" '
        f'viewBox="0 0 {length:.3f} {width:.3f}">',
        f'<rect id="roll" x="0" y="0" width="{length:.3f}" height="{width:.3f}" fill="none" stroke="#10b981" '
        'stroke-width="1"/>',
        '<g id="cut-paths" fill="none" stroke="#111827" stroke-width="0.5" fill-rule="evenodd">',
    ]
    for place in job["optimized_layout"]:
        piece = by_id[place["id"]]
        outer, holes = world_rings(piece, place)
        data = _ring_path(outer) + "".join(_ring_path(h) for h in holes)
        parts.append(
            f'<path id="piece-{piece["id"]}" data-name={quoteattr(piece.get("name", ""))} '
            f'data-rotation="{place["rotation_deg"]:g}" d="{data}"/>'
        )
    parts += ["</g>", "</svg>"]
    return "\n".join(parts) + "\n"


def _cut_order(job: dict[str, Any]) -> list[tuple[str, list[Point]]]:
    """Inner cuts come before a piece's outline, because a freed part can shift on the bed and
    ruin any cut still to be made in it. Pieces are visited nearest-neighbour to cut rapid travel."""
    by_id = {p["id"]: p for p in job["pieces"]}
    remaining = [(by_id[pl["id"]], *world_rings(by_id[pl["id"]], pl)) for pl in job["optimized_layout"]]
    pos: Point = (0.0, 0.0)
    ordered: list[tuple[str, list[Point]]] = []
    while remaining:
        best = min(range(len(remaining)), key=lambda i: math.dist(pos, remaining[i][1][0]))
        piece, outer, holes = remaining.pop(best)
        name = piece.get("name", str(piece["id"]))
        unvisited = list(holes)
        n = 0
        while unvisited:
            k = min(range(len(unvisited)), key=lambda i: math.dist(pos, unvisited[i][0]))
            ring = unvisited.pop(k)
            n += 1
            ordered.append((f"{name} / cut-out {n}", ring))
            pos = ring[0]
        ordered.append((f"{name} / outline", outer))
        pos = outer[0]
    return ordered


def export_gcode(job: dict[str, Any], feed_mm_min: float = 3000.0, rapid_mm_min: float = 12000.0) -> str:
    cuts = _cut_order(job)
    cut_mm = 0.0
    rapid_mm = 0.0
    pos: Point = (0.0, 0.0)
    body: list[str] = []
    for label, ring in cuts:
        rapid_mm += math.dist(pos, ring[0])
        body.append(f"; {label.replace(chr(10), ' ')}")
        body.append(f"G00 X{ring[0][0]:.3f} Y{ring[0][1]:.3f}")
        body.append("M03 ; beam on")
        prev = ring[0]
        for x, y in [*ring[1:], ring[0]]:
            cut_mm += math.dist(prev, (x, y))
            body.append(f"G01 X{x:.3f} Y{y:.3f} F{feed_mm_min:.0f}")
            prev = (x, y)
        body.append("M05 ; beam off")
        pos = ring[0]
    rapid_mm += math.dist(pos, (0.0, 0.0))
    minutes = cut_mm / feed_mm_min + rapid_mm / rapid_mm_min

    header = [
        f"; CutZero CNC toolpath: {job['name']}",
        f"; Sheet: {job['optimized_length_mm']:.1f} x {job['roll_width_mm']:.1f} mm | kerf {job['kerf_mm']} mm",
        f"; Pieces: {len(job['optimized_layout'])} | contours: {len(cuts)}",
        f"; Cut length: {cut_mm / 1000:.2f} m | rapid travel: {rapid_mm / 1000:.2f} m | est. {minutes:.1f} min",
        "; Check feed, power and the kerf offset for your machine before cutting.",
        "G21 ; millimetres",
        "G90 ; absolute coordinates",
        "G17 ; XY plane",
        "M05 ; beam off",
        "G00 X0.000 Y0.000",
    ]
    footer = ["G00 X0.000 Y0.000", "M05", "M30 ; end of program"]
    return "\n".join(header + body + footer) + "\n"
