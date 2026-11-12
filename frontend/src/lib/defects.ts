import type { Defect, Pt } from "../types";

/** A flaw is marked as a circle; the engine and both verifiers see it as a 24-sided polygon. */
export function defectPolygon(d: Defect): Pt[] {
  return Array.from({ length: 24 }, (_, k) => {
    const a = (2 * Math.PI * k) / 24;
    return [d.x + d.r * Math.cos(a), d.y + d.r * Math.sin(a)] as Pt;
  });
}

export const DEFAULT_FLAW_RADIUS = 30;

/** Clicking a flaw removes it; clicking clear roll adds one, kept inside the roll's width. */
export function toggleDefect(defects: Defect[], x: number, y: number, rollWidth: number): Defect[] {
  const hit = defects.findIndex((d) => Math.hypot(d.x - x, d.y - y) <= d.r + 6);
  if (hit >= 0) return defects.filter((_, i) => i !== hit);
  if (x < 0 || defects.length >= 50) return defects;
  const r = DEFAULT_FLAW_RADIUS;
  return [...defects, { x: Math.round(x), y: Math.round(Math.min(Math.max(y, 0), rollWidth)), r }];
}

/** A realistic spread for demos: flaws scattered through the part of the roll a nest uses. */
export function sampleDefects(length: number, rollWidth: number): Defect[] {
  const spots: Pt[] = [
    [0.16, 0.22],
    [0.38, 0.64],
    [0.6, 0.35],
    [0.82, 0.78],
  ];
  return spots.map(([fx, fy]) => ({ x: Math.round(fx * length), y: Math.round(fy * rollWidth), r: DEFAULT_FLAW_RADIUS }));
}
