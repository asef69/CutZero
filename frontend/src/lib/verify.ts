import type { Piece, Placement, Pt, Verification } from "../types";
import { ringBounds, worldRing } from "./geometry";

// TypeScript counterpart of backend/app/verify.py, for runs with no server. It re-derives
// clearance from the raw polygons and the reported placements and shares no code with the engine.

function ptSegSq(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len = vx * vx + vy * vy;
  const t = len > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len)) : 0;
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return dx * dx + dy * dy;
}

function side(p: Pt, q: Pt, r: Pt): number {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

function segDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (side(a, b, c) > 0 !== side(a, b, d) > 0 && side(c, d, a) > 0 !== side(c, d, b) > 0) return 0;
  return Math.sqrt(Math.min(ptSegSq(a, c, d), ptSegSq(b, c, d), ptSegSq(c, a, b), ptSegSq(d, a, b)));
}

function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    if (y0 > p[1] !== y1 > p[1] && p[0] < x0 + ((p[1] - y0) / (y1 - y0)) * (x1 - x0)) inside = !inside;
  }
  return inside;
}

export function verifyLayout(pieces: Piece[], layout: Placement[], rollWidth: number, kerf: number): Verification {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const placed = layout.map((pl) => {
    const piece = byId.get(pl.id)!;
    const outer = worldRing(piece.outer, pl);
    const holes = piece.holes.map((h) => worldRing(h, pl));
    const edges: [Pt, Pt][] = [];
    for (const ring of [outer, ...holes]) {
      ring.forEach((pt, i) => edges.push([pt, ring[(i + 1) % ring.length]]));
    }
    return { piece, outer, holes, edges, box: ringBounds(outer) };
  });
  const solid = (w: (typeof placed)[number], p: Pt) => inRing(p, w.outer) && !w.holes.some((h) => inRing(p, h));

  const tolerance = 1e-6;
  const problems: string[] = [];
  const seen = new Set(layout.map((l) => l.id));
  if (seen.size !== pieces.length) problems.push(`${pieces.length - seen.size} piece(s) missing from layout`);

  let min = Infinity;
  let pairs = 0;
  for (const w of placed) {
    const wall = Math.min(w.box.minX, w.box.minY, rollWidth - w.box.maxY);
    min = Math.min(min, wall);
    if (wall < kerf - tolerance) problems.push(`'${w.piece.name}' is ${wall.toFixed(3)} mm from the roll edge`);
  }
  const search = kerf + 25;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const gap = Math.max(b.box.minX - a.box.maxX, a.box.minX - b.box.maxX, b.box.minY - a.box.maxY, a.box.minY - b.box.maxY);
      if (gap > search) continue;
      pairs++;
      let d = Infinity;
      if (solid(b, a.outer[0]) || solid(a, b.outer[0])) {
        d = 0;
      } else {
        for (const [p, q] of a.edges) {
          for (const [r, s] of b.edges) {
            d = Math.min(d, segDist(p, q, r, s));
          }
        }
      }
      min = Math.min(min, d);
      if (d < kerf - tolerance) problems.push(`'${a.piece.name}' and '${b.piece.name}' are ${d.toFixed(3)} mm apart`);
    }
  }
  return {
    valid: problems.length === 0,
    verifier: "independent TypeScript exact geometry check",
    pieces_checked: placed.length,
    pairs_checked: pairs,
    min_clearance_mm: Number.isFinite(min) ? min : null,
    kerf_mm: kerf,
    problems: problems.slice(0, 20),
  };
}
