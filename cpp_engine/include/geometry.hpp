// geometry.hpp - exact 64-bit floating point 2D geometry for CutZero.
//
// Conventions
//   * The roll runs along +X (length) and spans [0, roll_width] along Y.
//   * Outer rings are counter-clockwise, hole rings are clockwise. With that
//     orientation, the winding number of a point summed over every ring is
//     non-zero exactly when the point lies in the solid material.
#pragma once

#include <cstddef>
#include <limits>
#include <string>
#include <vector>

namespace cutzero {

struct Point2D {
    double x = 0.0;
    double y = 0.0;
};

struct BBox {
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = std::numeric_limits<double>::infinity();
    double max_x = -std::numeric_limits<double>::infinity();
    double max_y = -std::numeric_limits<double>::infinity();

    void expand(const Point2D& p) {
        if (p.x < min_x) min_x = p.x;
        if (p.y < min_y) min_y = p.y;
        if (p.x > max_x) max_x = p.x;
        if (p.y > max_y) max_y = p.y;
    }
    double width() const { return max_x - min_x; }
    double height() const { return max_y - min_y; }
};

using Ring = std::vector<Point2D>;

// Signed Shoelace area: positive for counter-clockwise rings.
double ring_signed_area(const Ring& ring);

struct Polygon2D {
    Ring outer;
    std::vector<Ring> holes;

    // True material area in mm^2: Area(outer) - Sum(Area(holes)).
    double area() const;
    BBox bbox() const;
    // Forces outer -> CCW and holes -> CW.
    void normalize_winding();
    // Rotates about the origin.
    Polygon2D rotated(double degrees) const;
};

// Segment-segment squared distance (0 when they intersect).
double segment_distance_sq(double ax, double ay, double bx, double by,
                           double cx, double cy, double dx, double dy);

struct Edge {
    double ax, ay, bx, by;
};

// A polygon frozen at one rotation and normalised so its bbox starts at (0, 0).
// Flattening every ring into one edge list keeps the hot clearance loop simple.
struct PreparedShape {
    double rotation_deg = 0.0;
    double w = 0.0;
    double h = 0.0;
    // Translation that was applied after rotation to normalise the bbox.
    double norm_x = 0.0;
    double norm_y = 0.0;
    // Centroid of the bounding box in normalised coordinates.
    double center_x = 0.0;
    double center_y = 0.0;
    std::vector<Edge> edges;
    // First vertex of the outer ring, used for containment tests.
    Point2D probe{};

    static PreparedShape build(const Polygon2D& poly, double rotation_deg);

    // Winding-number containment in the solid (outer minus holes).
    bool contains(double x, double y) const;
};

// True when `a` at (ax, ay) and `b` at (bx, by) keep at least `kerf` of clearance.
// Handles nesting inside holes: a part fully inside another part's cut-out is clear.
bool shapes_clear(const PreparedShape& a, double ax, double ay,
                  const PreparedShape& b, double bx, double by, double kerf);

// Exact minimum distance between two placed shapes; 0 when they overlap.
double shapes_distance(const PreparedShape& a, double ax, double ay,
                       const PreparedShape& b, double bx, double by);

}  // namespace cutzero
