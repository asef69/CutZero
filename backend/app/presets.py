"""Three industrial nesting workloads, built from parametric curves in millimetres.

Garment pieces are drawn in pattern coordinates (u = across the body, v = down the
garment) and mapped so v runs along the roll. That is how real markers respect the
fabric's lengthwise grain.

    python -m app.presets        writes the engine test data and the frontend's offline copy
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .geometry_utils import Point, Ring, cubic, ensure_ccw, ensure_cw, quadratic, signed_area, simplify_to_budget


class Pen:
    """Small path builder: straight runs plus sampled Bezier curves."""

    def __init__(self, x: float, y: float, scale: float = 1.0) -> None:
        self.s = scale
        self.pts: Ring = [(x * scale, y * scale)]

    def _p(self, p: Point) -> Point:
        return (p[0] * self.s, p[1] * self.s)

    def line(self, x: float, y: float) -> "Pen":
        self.pts.append(self._p((x, y)))
        return self

    def curve(self, c1: Point, c2: Point, end: Point, steps: int = 14) -> "Pen":
        self.pts.extend(cubic(self.pts[-1], self._p(c1), self._p(c2), self._p(end), steps))
        return self

    def quad(self, c: Point, end: Point, steps: int = 10) -> "Pen":
        self.pts.extend(quadratic(self.pts[-1], self._p(c), self._p(end), steps))
        return self

    def ring(self) -> Ring:
        return self.pts


def circle(cx: float, cy: float, r: float, segments: int = 28) -> Ring:
    return [
        (cx + r * math.cos(2 * math.pi * i / segments), cy + r * math.sin(2 * math.pi * i / segments))
        for i in range(segments)
    ]


def rounded_rect(x: float, y: float, w: float, h: float, r: float) -> Ring:
    pen = Pen(x + r, y)
    pen.line(x + w - r, y).quad((x + w, y), (x + w, y + r), 5)
    pen.line(x + w, y + h - r).quad((x + w, y + h), (x + w - r, y + h), 5)
    pen.line(x + r, y + h).quad((x, y + h), (x, y + h - r), 5)
    pen.line(x, y + r).quad((x, y), (x + r, y), 5)
    return pen.ring()[:-1]


def to_roll(ring: Ring) -> Ring:
    """Maps pattern (u, v) to roll (x = v, y = u) so the garment length follows the grain."""
    return [(v, u) for u, v in ring]


def mirror(ring: Ring, axis: float = 0.0) -> Ring:
    return [(2 * axis - u, v) for u, v in ring]


# ---------------------------------------------------------------------------
# Men's dress shirt (two sizes on one marker, 14 pieces each)
# ---------------------------------------------------------------------------


def _shirt_front(s: float) -> Ring:
    return (
        Pen(0, 0, s)
        .quad((150, -22), (295, 18), 10)
        .curve((302, 180), (300, 340), (290, 500), 12)
        .curve((205, 525), (178, 640), (205, 745), 16)
        .line(92, 790)
        .curve((88, 730), (48, 682), (0, 678), 12)
        .ring()
    )


def _shirt_back(s: float) -> Ring:
    return (
        Pen(0, 18, s)
        .quad((295, -30), (590, 18), 14)
        .curve((598, 180), (596, 340), (590, 480), 12)
        .curve((520, 500), (500, 575), (505, 640), 12)
        .quad((295, 662), (85, 640), 12)
        .curve((90, 575), (70, 500), (0, 480), 12)
        .curve((-6, 340), (-8, 180), (0, 18), 12)
        .ring()
    )


def _shirt_yoke(s: float) -> Ring:
    return (
        Pen(0, 0, s)
        .quad((255, 22), (510, 0), 12)
        .line(505, 62)
        .line(342, 128)
        .curve((325, 88), (185, 88), (168, 128), 14)
        .line(5, 62)
        .ring()
    )


def _shirt_sleeve(s: float) -> Ring:
    return (
        Pen(130, 0, s)
        .line(372, 0)
        .curve((410, 170), (462, 320), (505, 425), 12)
        .curve((425, 438), (392, 610), (252, 618), 18)
        .curve((112, 610), (80, 438), (0, 425), 18)
        .curve((42, 320), (92, 170), (130, 0), 12)
        .ring()
    )


def _shirt_collar(s: float) -> Ring:
    return (
        Pen(0, 0, s)
        .quad((215, 34), (430, 0), 14)
        .line(452, 78)
        .quad((215, 118), (-22, 78), 14)
        .ring()
    )


def _shirt_stand(s: float) -> Ring:
    return (
        Pen(0, 0, s)
        .quad((205, 42), (410, 0), 14)
        .quad((425, 8), (420, 28), 4)
        .quad((205, 80), (-10, 28), 14)
        .quad((-15, 8), (0, 0), 4)
        .ring()
    )


def _shirt_pocket(s: float) -> Ring:
    return Pen(0, 28, s).line(62, 0).line(124, 28).line(124, 148).line(0, 148).ring()


def _shirt_size(tag: str, s: float) -> list[dict[str, Any]]:
    front = _shirt_front(s)
    sleeve = _shirt_sleeve(s)
    pieces = [
        (f"Front panel R ({tag})", front),
        (f"Front panel L ({tag})", mirror(front)),
        (f"Back panel ({tag})", _shirt_back(s)),
        (f"Outer yoke ({tag})", _shirt_yoke(s)),
        (f"Inner yoke ({tag})", _shirt_yoke(s)),
        (f"Sleeve R ({tag})", sleeve),
        (f"Sleeve L ({tag})", mirror(sleeve)),
        (f"Top collar ({tag})", _shirt_collar(s)),
        (f"Under collar ({tag})", _shirt_collar(s)),
        (f"Collar stand A ({tag})", _shirt_stand(s)),
        (f"Collar stand B ({tag})", _shirt_stand(s)),
        (f"Cuff R ({tag})", rounded_rect(0, 0, 252 * s, 68 * s, 14)),
        (f"Cuff L ({tag})", rounded_rect(0, 0, 252 * s, 68 * s, 14)),
        (f"Chest pocket ({tag})", _shirt_pocket(s)),
    ]
    return [_piece(name, to_roll(ring)) for name, ring in pieces]


def mens_dress_shirt() -> dict[str, Any]:
    return _preset(
        "mens_dress_shirt",
        "Men's Dress Shirt",
        "Two-size marker (M + L): curved armholes, tapered sleeves, collars and cuffs in 180 GSM cotton.",
        "textile",
        "Woven cotton shirting",
        1500.0,
        180.0,
        15.2,
        [0, 180],
        _shirt_size("M", 1.0) + _shirt_size("L", 1.06),
    )


# ---------------------------------------------------------------------------
# Technical shell jacket (36 pieces)
# ---------------------------------------------------------------------------


def _jk_front_upper() -> Ring:
    return (
        Pen(0, 0)
        .quad((150, -16), (300, 10), 10)
        .curve((308, 110), (305, 180), (300, 262), 10)
        .curve((225, 280), (205, 370), (232, 468), 14)
        .line(110, 510)
        .curve((105, 450), (60, 408), (0, 402), 12)
        .ring()
    )


def _jk_front_lower() -> Ring:
    return Pen(0, 0).quad((130, 26), (262, 0), 10).line(280, 330).quad((140, 300), (0, 330), 10).ring()


def _jk_side_gore() -> Ring:
    return (
        Pen(40, 0)
        .line(190, 0)
        .curve((215, 200), (232, 360), (225, 590), 14)
        .curve((165, 610), (92, 610), (0, 590), 10)
        .curve((-6, 360), (15, 200), (40, 0), 14)
        .ring()
    )


def _jk_back_yoke() -> Ring:
    return (
        Pen(0, 0)
        .quad((290, 40), (580, 0), 14)
        .line(560, 110)
        .line(385, 212)
        .curve((362, 158), (218, 158), (195, 212), 14)
        .line(20, 110)
        .ring()
    )


def _jk_back_body() -> Ring:
    return (
        Pen(0, 18)
        .quad((285, -32), (570, 18), 14)
        .curve((580, 220), (560, 420), (540, 610), 14)
        .quad((285, 650), (30, 610), 14)
        .curve((10, 420), (-10, 220), (0, 18), 14)
        .ring()
    )


def _jk_upper_sleeve() -> Ring:
    return (
        Pen(60, 0)
        .line(265, 0)
        .curve((302, 200), (340, 410), (368, 620), 14)
        .curve((300, 708), (130, 720), (0, 640), 18)
        .curve((6, 420), (32, 200), (60, 0), 14)
        .ring()
    )


def _jk_under_sleeve() -> Ring:
    return (
        Pen(20, 0)
        .line(172, 0)
        .curve((210, 170), (252, 340), (272, 480), 12)
        .curve((205, 460), (70, 460), (0, 482), 14)
        .curve((-8, 320), (8, 160), (20, 0), 12)
        .ring()
    )


def _jk_gusset() -> Ring:
    return Pen(0, 0).curve((70, 34), (140, 34), (210, 0), 10).curve((180, 70), (135, 128), (105, 156), 8).curve((75, 128), (30, 70), (0, 0), 8).ring()


def _jk_hood_side() -> Ring:
    return (
        Pen(0, 0)
        .curve((120, -28), (240, -18), (345, 28), 12)
        .curve((415, 130), (420, 285), (345, 395), 18)
        .curve((250, 440), (140, 420), (70, 345), 14)
        .curve((46, 240), (20, 110), (0, 0), 12)
        .ring()
    )


def _jk_hood_center() -> Ring:
    return (
        Pen(0, 0)
        .quad((68, 18), (135, 0), 8)
        .curve((165, 200), (160, 430), (118, 700), 18)
        .quad((68, 720), (18, 700), 8)
        .curve((-24, 430), (-28, 200), (0, 0), 18)
        .ring()
    )


def _jk_storm_flap() -> Ring:
    return Pen(0, 0).line(58, 0).curve((76, 240), (76, 500), (60, 742), 16).quad((30, 765), (0, 742), 6).ring()


def _jk_collar() -> Ring:
    return Pen(0, 0).quad((190, 60), (380, 0), 14).line(395, 95).quad((190, 165), (-15, 95), 14).ring()


def _jk_flap() -> Ring:
    return Pen(0, 12).line(205, 0).line(218, 46).quad((110, 96), (6, 62), 10).ring()


def _jk_pocket_bag() -> Ring:
    return Pen(0, 18).quad((95, -24), (190, 18), 10).line(215, 245).quad((105, 300), (-18, 245), 12).ring()


def _jk_brim() -> Ring:
    return Pen(0, 0).quad((215, 88), (430, 0), 16).line(415, 38).quad((215, 138), (15, 38), 16).ring()


def _jk_hem() -> Ring:
    return Pen(0, 0).quad((170, 22), (345, 0), 12).line(350, 48).quad((170, 70), (-5, 48), 12).ring()


def _jk_garage() -> Ring:
    return Pen(0, 0).line(46, 0).quad((62, 32), (46, 66), 6).line(0, 66).ring()


def _jk_tab() -> Ring:
    return Pen(0, 0).line(170, 0).quad((205, 26), (170, 52), 6).line(0, 52).ring()


def technical_shell_jacket() -> dict[str, Any]:
    named: list[tuple[str, Ring, int]] = [
        ("Front upper", _jk_front_upper(), 2),
        ("Front lower", _jk_front_lower(), 2),
        ("Side gore", _jk_side_gore(), 2),
        ("Back yoke", _jk_back_yoke(), 1),
        ("Back body", _jk_back_body(), 1),
        ("Upper sleeve", _jk_upper_sleeve(), 2),
        ("Under sleeve", _jk_under_sleeve(), 2),
        ("Underarm gusset", _jk_gusset(), 2),
        ("Hood side", _jk_hood_side(), 2),
        ("Hood center", _jk_hood_center(), 1),
        ("Hood brim", _jk_brim(), 1),
        ("Storm flap", _jk_storm_flap(), 2),
        ("Collar", _jk_collar(), 2),
        ("Pocket flap", _jk_flap(), 2),
        ("Pocket bag", _jk_pocket_bag(), 4),
        ("Hem facing", _jk_hem(), 2),
        ("Zip garage", _jk_garage(), 2),
        ("Cuff tab", _jk_tab(), 4),
    ]
    pieces = []
    for name, ring, count in named:
        for i in range(count):
            # Left/right pairs are true mirror images; the rest are repeated cuts.
            side = (" R" if i % 2 == 0 else " L") if count % 2 == 0 else ""
            source = mirror(ring) if count % 2 == 0 and i % 2 == 1 else ring
            suffix = f"{side} {i // 2 + 1}" if count > 2 else side
            pieces.append(_piece(f"{name}{suffix}", to_roll(source)))
    return _preset(
        "technical_shell_jacket",
        "Technical Shell Jacket",
        "Articulated gores, hood panels and storm flaps in 220 GSM ripstop nylon.",
        "textile",
        "Ripstop nylon",
        1400.0,
        220.0,
        15.2,
        [0, 180],
        pieces,
    )


# ---------------------------------------------------------------------------
# Sheet-metal enclosure (24 pieces, with real internal cut-outs)
# ---------------------------------------------------------------------------


def _m_l_bracket(a: float, b: float, leg: float, r: float = 10) -> Ring:
    return (
        Pen(0, 0)
        .line(a, 0)
        .line(a, leg)
        .line(leg + r, leg)
        .quad((leg, leg), (leg, leg + r), 4)
        .line(leg, b)
        .line(0, b)
        .ring()
    )


def _m_u_frame(w: float, h: float, leg: float) -> Ring:
    return Pen(0, 0).line(w, 0).line(w, h).line(w - leg, h).line(w - leg, leg).line(leg, leg).line(leg, h).line(0, h).ring()


def _m_fan_plate(size: float, hole_r: float) -> tuple[Ring, list[Ring]]:
    outer = rounded_rect(0, 0, size, size, 16)
    c = size / 2
    screw_inset = 26.0
    holes = [circle(c, c, hole_r, 36)]
    for sx in (screw_inset, size - screw_inset):
        for sy in (screw_inset, size - screw_inset):
            holes.append(circle(sx, sy, 5.0, 10))
    return outer, holes


def _m_comb(w: float, h: float, teeth: int, depth: float) -> Ring:
    pen = Pen(0, 0).line(w, 0).line(w, h)
    pitch = w / (2 * teeth + 1)
    x = w
    for _ in range(teeth):
        x -= pitch
        pen.line(x, h).line(x, h - depth)
        x -= pitch
        pen.line(x, h - depth).line(x, h)
    pen.line(0, h)
    return pen.ring()


def _m_t_brace(w: float, h: float, bar: float, stem: float) -> Ring:
    left = (w - stem) / 2
    return Pen(0, h - bar).line(left, h - bar).line(left, 0).line(left + stem, 0).line(left + stem, h - bar).line(w, h - bar).line(w, h).line(0, h).ring()


def _m_gusset(a: float) -> Ring:
    return Pen(0, 0).line(a, 0).curve((a * 0.62, a * 0.2), (a * 0.2, a * 0.62), (0, a), 10).ring()


def _m_hinge(w: float, h: float) -> Ring:
    return rounded_rect(0, 0, w, h, 12)


def sheet_metal_enclosure() -> dict[str, Any]:
    pieces: list[dict[str, Any]] = []
    for i in range(4):
        pieces.append(_piece(f"Large L-bracket {i + 1}", _m_l_bracket(420, 300, 95)))
    for i in range(4):
        pieces.append(_piece(f"Small L-bracket {i + 1}", _m_l_bracket(200, 150, 58)))
    for i in range(4):
        pieces.append(_piece(f"U-frame {i + 1}", _m_u_frame(500, 300, 82)))
    for i in range(3):
        outer, holes = _m_fan_plate(320, 118)
        pieces.append(_piece(f"Fan cut-out plate {i + 1}", outer, holes))
    for i in range(2):
        pieces.append(_piece(f"Vent comb plate {i + 1}", _m_comb(600, 165, 6, 92)))
    window = rounded_rect(110, 90, 500, 250, 18)
    pieces.append(_piece("Chassis window frame", rounded_rect(0, 0, 720, 430, 22), [window]))
    for i in range(2):
        pieces.append(_piece(f"T-brace {i + 1}", _m_t_brace(280, 240, 62, 66)))
    for i in range(2):
        pieces.append(_piece(f"Corner gusset {i + 1}", _m_gusset(150)))
    pieces.append(_piece("Hinge plate", _m_hinge(170, 72)))
    pieces.append(_piece("Latch plate", _m_hinge(120, 64)))
    return _preset(
        "sheet_metal_enclosure",
        "Sheet Metal Enclosure",
        "L-brackets, U-frames and fan cut-out plates on a 1200 mm sheet of 1 mm aluminium. Parts can nest inside cut-outs.",
        "metal",
        "1 mm aluminium sheet",
        1200.0,
        2700.0,
        11.5,
        [0, 90, 180, 270],
        pieces,
    )


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def _clean(ring: Ring) -> Ring:
    # Budget chosen with the engine's per-placement cost in mind; 0.25 mm is the PRD's epsilon.
    return simplify_to_budget(ring, epsilon=0.25, max_vertices=64)


def _piece(name: str, outer: Ring, holes: list[Ring] | None = None) -> dict[str, Any]:
    outer_clean = ensure_ccw(_clean(outer))
    min_x = min(p[0] for p in outer_clean)
    min_y = min(p[1] for p in outer_clean)
    shift = lambda ring: [(round(x - min_x, 4), round(y - min_y, 4)) for x, y in ring]  # noqa: E731
    hole_rings = [shift(ensure_cw(_clean(h))) for h in (holes or [])]
    outer_final = shift(outer_clean)
    area = abs(signed_area(outer_final)) - sum(abs(signed_area(h)) for h in hole_rings)
    return {
        "name": name,
        "outer": [list(p) for p in outer_final],
        "holes": [[list(p) for p in h] for h in hole_rings],
        "area_mm2": round(area, 2),
    }


def _preset(
    preset_id: str,
    name: str,
    description: str,
    category: str,
    material: str,
    roll_width: float,
    gsm: float,
    ef: float,
    rotations: list[int],
    pieces: list[dict[str, Any]],
) -> dict[str, Any]:
    for i, piece in enumerate(pieces):
        piece["id"] = i
    return {
        "id": preset_id,
        "name": name,
        "description": description,
        "category": category,
        "material": material,
        "roll_width_mm": roll_width,
        "fabric_gsm": gsm,
        "co2_factor_kg_per_kg": ef,
        "default_rotations_deg": rotations,
        "default_kerf_mm": 2.0,
        "default_batch_count": 100,
        "piece_count": len(pieces),
        "total_area_m2": round(sum(p["area_mm2"] for p in pieces) / 1e6, 4),
        "pieces": pieces,
    }


_CACHE: dict[str, dict[str, Any]] | None = None


def all_presets() -> dict[str, dict[str, Any]]:
    global _CACHE
    if _CACHE is None:
        _CACHE = {p["id"]: p for p in (mens_dress_shirt(), technical_shell_jacket(), sheet_metal_enclosure())}
    return _CACHE


def write_engine_testdata(directory: Path) -> None:
    """Plain-text dump the zero-dependency C++ test bench can read without a JSON parser."""
    directory.mkdir(parents=True, exist_ok=True)
    for preset in all_presets().values():
        lines = [
            f"{preset['id']} {preset['roll_width_mm']} {preset['default_kerf_mm']} {preset['fabric_gsm']} "
            f"{preset['co2_factor_kg_per_kg']}",
            " ".join(str(r) for r in [len(preset["default_rotations_deg"]), *preset["default_rotations_deg"]]),
            str(len(preset["pieces"])),
        ]
        for piece in preset["pieces"]:
            rings = [piece["outer"], *piece["holes"]]
            lines.append(str(len(rings)))
            for ring in rings:
                lines.append(" ".join([str(len(ring)), *(f"{x} {y}" for x, y in ring)]))
        (directory / f"{preset['id']}.txt").write_text("\n".join(lines) + "\n", encoding="ascii")


def write_frontend_presets(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(list(all_presets().values()), separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    write_engine_testdata(root / "cpp_engine" / "testdata")
    write_frontend_presets(root / "frontend" / "public" / "presets.json")
    for preset in all_presets().values():
        vertices = [len(p["outer"]) for p in preset["pieces"]]
        print(
            f"{preset['id']:<26} {preset['piece_count']:>3} pieces  "
            f"{preset['total_area_m2']:.3f} m2  vertices {min(vertices)}-{max(vertices)}"
        )
