#include "geometry.hpp"

#include "fft2d.hpp"  // CUTZERO_TLS

#include <algorithm>
#include <cmath>
#include <numbers>

namespace cutzero {

double ring_signed_area(const Ring& ring) {
    const std::size_t n = ring.size();
    if (n < 3) return 0.0;
    double sum = 0.0;
    for (std::size_t i = 0; i < n; ++i) {
        const Point2D& a = ring[i];
        const Point2D& b = ring[(i + 1) % n];
        sum += a.x * b.y - b.x * a.y;
    }
    return 0.5 * sum;
}

double Polygon2D::area() const {
    double total = std::fabs(ring_signed_area(outer));
    for (const Ring& h : holes) total -= std::fabs(ring_signed_area(h));
    return total;
}

BBox Polygon2D::bbox() const {
    BBox box;
    for (const Point2D& p : outer) box.expand(p);
    return box;
}

void Polygon2D::normalize_winding() {
    if (ring_signed_area(outer) < 0.0) std::reverse(outer.begin(), outer.end());
    for (Ring& h : holes) {
        if (ring_signed_area(h) > 0.0) std::reverse(h.begin(), h.end());
    }
}

Polygon2D Polygon2D::rotated(double degrees) const {
    // Quarter turns stay perfectly exact instead of picking up sin/cos noise.
    double wrapped = std::fmod(degrees, 360.0);
    if (wrapped < 0) wrapped += 360.0;
    double c, s;
    if (wrapped == 0.0) {
        c = 1; s = 0;
    } else if (wrapped == 90.0) {
        c = 0; s = 1;
    } else if (wrapped == 180.0) {
        c = -1; s = 0;
    } else if (wrapped == 270.0) {
        c = 0; s = -1;
    } else {
        const double r = wrapped * std::numbers::pi / 180.0;
        c = std::cos(r);
        s = std::sin(r);
    }
    auto rotate_ring = [c, s](const Ring& in) {
        Ring out;
        out.reserve(in.size());
        for (const Point2D& p : in) out.push_back({c * p.x - s * p.y, s * p.x + c * p.y});
        return out;
    };
    Polygon2D result;
    result.outer = rotate_ring(outer);
    result.holes.reserve(holes.size());
    for (const Ring& h : holes) result.holes.push_back(rotate_ring(h));
    return result;
}

namespace {

inline double point_segment_distance_sq(double px, double py, double ax, double ay, double bx, double by) {
    const double vx = bx - ax;
    const double vy = by - ay;
    const double wx = px - ax;
    const double wy = py - ay;
    const double len = vx * vx + vy * vy;
    double t = len > 0.0 ? (wx * vx + wy * vy) / len : 0.0;
    t = std::clamp(t, 0.0, 1.0);
    const double dx = wx - t * vx;
    const double dy = wy - t * vy;
    return dx * dx + dy * dy;
}

inline bool segments_cross(double ax, double ay, double bx, double by,
                           double cx, double cy, double dx, double dy) {
    const double d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const double d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    const double d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const double d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    return ((d1 > 0) != (d2 > 0)) && ((d3 > 0) != (d4 > 0));
}

}  // namespace

double segment_distance_sq(double ax, double ay, double bx, double by,
                           double cx, double cy, double dx, double dy) {
    if (segments_cross(ax, ay, bx, by, cx, cy, dx, dy)) return 0.0;
    double best = point_segment_distance_sq(ax, ay, cx, cy, dx, dy);
    best = std::min(best, point_segment_distance_sq(bx, by, cx, cy, dx, dy));
    best = std::min(best, point_segment_distance_sq(cx, cy, ax, ay, bx, by));
    best = std::min(best, point_segment_distance_sq(dx, dy, ax, ay, bx, by));
    return best;
}

PreparedShape PreparedShape::build(const Polygon2D& poly, double rotation_deg) {
    Polygon2D turned = poly.rotated(rotation_deg);
    turned.normalize_winding();
    const BBox box = turned.bbox();

    PreparedShape shape;
    shape.rotation_deg = rotation_deg;
    shape.w = box.width();
    shape.h = box.height();
    shape.norm_x = -box.min_x;
    shape.norm_y = -box.min_y;
    shape.center_x = shape.w * 0.5;
    shape.center_y = shape.h * 0.5;
    shape.probe = {turned.outer[0].x + shape.norm_x, turned.outer[0].y + shape.norm_y};

    auto add_ring = [&](const Ring& ring) {
        const std::size_t n = ring.size();
        for (std::size_t i = 0; i < n; ++i) {
            const Point2D& a = ring[i];
            const Point2D& b = ring[(i + 1) % n];
            shape.edges.push_back({a.x + shape.norm_x, a.y + shape.norm_y, b.x + shape.norm_x, b.y + shape.norm_y});
        }
    };
    add_ring(turned.outer);
    for (const Ring& h : turned.holes) add_ring(h);
    return shape;
}

bool PreparedShape::contains(double x, double y) const {
    int winding = 0;
    for (const Edge& e : edges) {
        if (e.ay <= y) {
            if (e.by > y) {
                const double side = (e.bx - e.ax) * (y - e.ay) - (x - e.ax) * (e.by - e.ay);
                if (side > 0) ++winding;
            }
        } else if (e.by <= y) {
            const double side = (e.bx - e.ax) * (y - e.ay) - (x - e.ax) * (e.by - e.ay);
            if (side < 0) --winding;
        }
    }
    return winding != 0;
}

bool shapes_clear(const PreparedShape& a, double ax, double ay,
                  const PreparedShape& b, double bx, double by, double kerf) {
    // Work in b's local frame.
    const double ox = ax - bx;
    const double oy = ay - by;

    // Bounding box gap: most probes end here.
    if (ox >= b.w + kerf || oy >= b.h + kerf || ox + a.w + kerf <= 0.0 || oy + a.h + kerf <= 0.0) {
        return true;
    }

    const double win_min_x = std::max(ox, 0.0) - kerf;
    const double win_min_y = std::max(oy, 0.0) - kerf;
    const double win_max_x = std::min(ox + a.w, b.w) + kerf;
    const double win_max_y = std::min(oy + a.h, b.h) + kerf;
    const double kerf_sq = kerf * kerf;

    // Only edges that reach the overlap window can possibly be within kerf.
    CUTZERO_TLS std::vector<Edge> near_b;
    near_b.clear();
    for (const Edge& e : b.edges) {
        const double lo_x = std::min(e.ax, e.bx);
        const double hi_x = std::max(e.ax, e.bx);
        const double lo_y = std::min(e.ay, e.by);
        const double hi_y = std::max(e.ay, e.by);
        if (hi_x < win_min_x || lo_x > win_max_x || hi_y < win_min_y || lo_y > win_max_y) continue;
        near_b.push_back(e);
    }

    if (!near_b.empty()) {
        for (const Edge& raw : a.edges) {
            const double p1x = raw.ax + ox;
            const double p1y = raw.ay + oy;
            const double p2x = raw.bx + ox;
            const double p2y = raw.by + oy;
            const double lo_x = std::min(p1x, p2x);
            const double hi_x = std::max(p1x, p2x);
            const double lo_y = std::min(p1y, p2y);
            const double hi_y = std::max(p1y, p2y);
            if (hi_x < win_min_x || lo_x > win_max_x || hi_y < win_min_y || lo_y > win_max_y) continue;
            for (const Edge& e : near_b) {
                if (std::min(e.ax, e.bx) > hi_x + kerf || std::max(e.ax, e.bx) < lo_x - kerf ||
                    std::min(e.ay, e.by) > hi_y + kerf || std::max(e.ay, e.by) < lo_y - kerf) {
                    continue;
                }
                if (segment_distance_sq(p1x, p1y, p2x, p2y, e.ax, e.ay, e.bx, e.by) < kerf_sq) return false;
            }
        }
    }

    // No boundaries are close, so the shapes are either disjoint or strictly nested.
    if (b.contains(a.probe.x + ox, a.probe.y + oy)) return false;
    if (a.contains(b.probe.x - ox, b.probe.y - oy)) return false;
    return true;
}

double shapes_distance(const PreparedShape& a, double ax, double ay,
                       const PreparedShape& b, double bx, double by) {
    const double ox = ax - bx;
    const double oy = ay - by;
    if (b.contains(a.probe.x + ox, a.probe.y + oy)) return 0.0;
    if (a.contains(b.probe.x - ox, b.probe.y - oy)) return 0.0;
    double best = std::numeric_limits<double>::infinity();
    for (const Edge& ea : a.edges) {
        for (const Edge& eb : b.edges) {
            const double d = segment_distance_sq(ea.ax + ox, ea.ay + oy, ea.bx + ox, ea.by + oy,
                                                 eb.ax, eb.ay, eb.bx, eb.by);
            if (d < best) best = d;
        }
    }
    return std::sqrt(best);
}

}  // namespace cutzero
