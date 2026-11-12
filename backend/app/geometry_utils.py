"""Pure-Python polygon helpers shared by the presets and the SVG parser."""

from __future__ import annotations

import math
from typing import Iterable, Sequence

Point = tuple[float, float]
Ring = list[Point]


def signed_area(ring: Sequence[Point]) -> float:
    """Shoelace formula. Positive means counter-clockwise."""
    total = 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        total += x0 * y1 - x1 * y0
    return total * 0.5


def ensure_ccw(ring: Sequence[Point]) -> Ring:
    return list(ring) if signed_area(ring) >= 0 else list(reversed(ring))


def ensure_cw(ring: Sequence[Point]) -> Ring:
    return list(ring) if signed_area(ring) <= 0 else list(reversed(ring))


def _perpendicular_distance(p: Point, a: Point, b: Point) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    if length == 0.0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    return abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / length


def _dp_open(points: Sequence[Point], epsilon: float) -> Ring:
    """Iterative Douglas-Peucker on an open polyline, so long paths cannot overflow the stack."""
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        best, best_i = 0.0, -1
        for i in range(lo + 1, hi):
            d = _perpendicular_distance(points[i], points[lo], points[hi])
            if d > best:
                best, best_i = d, i
        if best > epsilon and best_i > 0:
            keep[best_i] = True
            stack.append((lo, best_i))
            stack.append((best_i, hi))
    return [p for p, k in zip(points, keep) if k]


def douglas_peucker_ring(ring: Sequence[Point], epsilon: float = 0.25) -> Ring:
    """Simplifies a closed ring, anchoring on the two mutually farthest-apart vertices."""
    points = dedupe(ring)
    if len(points) < 4:
        return points
    a = 0
    b = max(range(len(points)), key=lambda i: _sq(points[i], points[a]))
    a = max(range(len(points)), key=lambda i: _sq(points[i], points[b]))
    lo, hi = min(a, b), max(a, b)
    first = _dp_open(points[lo : hi + 1], epsilon)
    second = _dp_open(points[hi:] + points[: lo + 1], epsilon)
    simplified = first[:-1] + second[:-1]
    return simplified if len(simplified) >= 3 else points


def simplify_to_budget(ring: Sequence[Point], epsilon: float = 0.25, max_vertices: int = 80) -> Ring:
    """Applies Douglas-Peucker, loosening epsilon until the vertex budget is met."""
    current = douglas_peucker_ring(ring, epsilon)
    eps = epsilon
    while len(current) > max_vertices and eps < 50.0:
        eps *= 1.5
        current = douglas_peucker_ring(ring, eps)
    return current


def _sq(a: Point, b: Point) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def dedupe(ring: Iterable[Point], tolerance: float = 1e-6) -> Ring:
    out: Ring = []
    for p in ring:
        if not out or _sq(p, out[-1]) > tolerance * tolerance:
            out.append((float(p[0]), float(p[1])))
    while len(out) > 1 and _sq(out[0], out[-1]) <= tolerance * tolerance:
        out.pop()
    return out


def point_in_ring(p: Point, ring: Sequence[Point]) -> bool:
    x, y = p
    inside = False
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) / (y1 - y0) * (x1 - x0):
            inside = not inside
    return inside


def cubic(p0: Point, p1: Point, p2: Point, p3: Point, steps: int) -> Ring:
    """Samples a cubic Bezier at `steps` points, excluding p0."""
    out: Ring = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1.0 - t
        a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def quadratic(p0: Point, p1: Point, p2: Point, steps: int) -> Ring:
    """Samples a quadratic Bezier at `steps` points, excluding p0."""
    out: Ring = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1.0 - t
        a, b, c = u * u, 2 * u * t, t * t
        out.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]))
    return out


def adaptive_steps(length_estimate: float, tolerance_mm: float = 2.0) -> int:
    """Picks a sample count from a curve's rough length; simplification trims the excess."""
    return max(6, min(48, int(length_estimate / max(tolerance_mm, 0.5))))
