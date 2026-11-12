import type { Placement, Pt } from "../types";

export function worldRing(ring: Pt[], p: Placement): Pt[] {
  const r = (p.rotation_deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return ring.map(([x, y]) => [c * x - s * y + p.tx, s * x + c * y + p.ty]);
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function ringBounds(ring: Pt[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function ringCentroid(ring: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPiece(p: Pt, outer: Pt[], holes: Pt[][]): boolean {
  const inRing = (ring: Pt[]) => {
    let inside = false;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      if (y0 > p[1] !== y1 > p[1] && p[0] < x0 + ((p[1] - y0) / (y1 - y0)) * (x1 - x0)) inside = !inside;
    }
    return inside;
  };
  return inRing(outer) && !holes.some(inRing);
}

/** Hues for piece families, in a fixed order. */
const HUES = ["#5aa9e6", "#7fc8a9", "#c9a7eb", "#f2b880", "#e8a0bf", "#7fd6d6", "#a8c686", "#94a8e8", "#d9c37a"];

export function pieceFamily(name: string): string {
  return name
    .replace(/\s*\(.*\)$/, "")
    .replace(/\s+(R|L|A|B)(\s+\d+)?$/, "")
    .replace(/\s+\d+$/, "");
}

/** Pieces cut from the same pattern share a color; families are colored in order of first appearance. */
export function familyColors(names: string[]): string[] {
  const order = new Map<string, number>();
  return names.map((name) => {
    const family = pieceFamily(name);
    if (!order.has(family)) order.set(family, order.size);
    return HUES[order.get(family)! % HUES.length];
  });
}
