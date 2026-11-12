"""Writes frontend/public/samples/flange_kit.dxf, the studio's DXF sample.

It deliberately mixes the ways CAD tools describe outlines, so it exercises the importer:
LWPOLYLINE with bulge arcs (rounded flanges), CIRCLE holes, outlines drawn as separate LINE
and ARC segments (L-brackets), and a part placed through a BLOCK + INSERT pair.
"""

from __future__ import annotations

import math
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "frontend" / "public" / "samples" / "flange_kit.dxf"
BULGE_90 = math.tan(math.radians(90) / 4)


class Dxf:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def pair(self, code: int, value: object) -> None:
        self.lines += [str(code), f"{value:.4f}" if isinstance(value, float) else str(value)]

    def lwpolyline(self, pts: list[tuple[float, float, float]], layer: str = "CUT") -> None:
        self.pair(0, "LWPOLYLINE")
        self.pair(8, layer)
        self.pair(90, len(pts))
        self.pair(70, 1)
        for x, y, bulge in pts:
            self.pair(10, float(x))
            self.pair(20, float(y))
            if bulge:
                self.pair(42, float(bulge))

    def circle(self, x: float, y: float, r: float, layer: str = "CUT") -> None:
        self.pair(0, "CIRCLE")
        self.pair(8, layer)
        self.pair(10, float(x))
        self.pair(20, float(y))
        self.pair(40, float(r))

    def line(self, a: tuple[float, float], b: tuple[float, float]) -> None:
        self.pair(0, "LINE")
        self.pair(8, "CUT")
        self.pair(10, float(a[0]))
        self.pair(20, float(a[1]))
        self.pair(11, float(b[0]))
        self.pair(21, float(b[1]))

    def arc(self, x: float, y: float, r: float, start: float, end: float) -> None:
        self.pair(0, "ARC")
        self.pair(8, "CUT")
        self.pair(10, float(x))
        self.pair(20, float(y))
        self.pair(40, float(r))
        self.pair(50, float(start))
        self.pair(51, float(end))


def flange(d: Dxf, ox: float, oy: float) -> None:
    w, h, r = 180.0, 120.0, 18.0
    d.lwpolyline(
        [
            (ox + r, oy, 0), (ox + w - r, oy, BULGE_90), (ox + w, oy + r, 0), (ox + w, oy + h - r, BULGE_90),
            (ox + w - r, oy + h, 0), (ox + r, oy + h, BULGE_90), (ox, oy + h - r, 0), (ox, oy + r, BULGE_90),
        ]
    )
    d.circle(ox + w / 2, oy + h / 2, 34.0)
    for hx, hy in ((22, 22), (w - 22, 22), (w - 22, h - 22), (22, h - 22)):
        d.circle(ox + hx, oy + hy, 6.0)


def bracket(d: Dxf, ox: float, oy: float) -> None:
    """An L-bracket with a rounded inside corner, as loose LINE and ARC entities."""
    a, t, r = 140.0, 36.0, 12.0
    p = lambda x, y: (ox + x, oy + y)  # noqa: E731
    d.line(p(0, 0), p(a, 0))
    d.line(p(a, 0), p(a, t))
    d.line(p(a, t), p(t + r, t))
    d.arc(ox + t + r, oy + t + r, r, 180, 270)
    d.line(p(t, t + r), p(t, a))
    d.line(p(t, a), p(0, a))
    d.line(p(0, a), p(0, 0))


def main() -> None:
    d = Dxf()
    d.pair(999, "CutZero sample: flange kit (mm)")
    d.pair(0, "SECTION")
    d.pair(2, "HEADER")
    d.pair(9, "$INSUNITS")
    d.pair(70, 4)
    d.pair(0, "ENDSEC")
    # A gusset defined once as a block and placed with INSERT.
    d.pair(0, "SECTION")
    d.pair(2, "BLOCKS")
    d.pair(0, "BLOCK")
    d.pair(8, "0")
    d.pair(2, "Gusset")
    d.pair(10, 0.0)
    d.pair(20, 0.0)
    d.lwpolyline([(0, 0, 0), (90, 0, 0), (0, 90, 0)])
    d.circle(22.0, 22.0, 7.0)
    d.pair(0, "ENDBLK")
    d.pair(0, "ENDSEC")

    d.pair(0, "SECTION")
    d.pair(2, "ENTITIES")
    for i in range(6):
        flange(d, 200.0 * (i % 3), 140.0 * (i // 3))
    for i in range(6):
        bracket(d, 160.0 * i, 320.0)
    for i in range(10):
        d.circle(60.0 + 70.0 * i, 520.0, 24.0)  # Small blanks that fit a flange's centre hole.
    for i in range(6):
        d.pair(0, "INSERT")
        d.pair(8, "CUT")
        d.pair(2, "Gusset")
        d.pair(10, 110.0 * i)
        d.pair(20, 600.0)
        d.pair(50, 0.0)
    d.pair(0, "ENDSEC")
    d.pair(0, "EOF")
    OUT.write_text("\n".join(d.lines) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
