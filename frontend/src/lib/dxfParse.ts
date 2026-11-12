import type { Piece, Pt } from "../types";
import { piecesFromRings } from "./svgParse";

// DXF import, in the browser, so it works on either engine. Covers what pattern CAD and
// sheet-metal CAD export: LWPOLYLINE and POLYLINE (with bulge arcs), CIRCLE, ELLIPSE, and
// outlines drawn as separate LINE and ARC segments, which are chained into closed loops.
// Blocks placed with INSERT are expanded, which is how AAMA/ASTM garment DXF stores each piece.

type Pair = [number, string];
interface Entity {
  type: string;
  layer: string;
  data: Pair[];
}
interface Shape {
  name: string;
  layer: string;
  points: Pt[];
  closed: boolean;
}

const INSUNITS_MM: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
const CHAIN_TOL = 0.05; // mm

function readPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1].trim()]);
  }
  return pairs;
}

function sections(pairs: Pair[]): Map<string, Pair[]> {
  const out = new Map<string, Pair[]>();
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === "SECTION" && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1];
      const start = i + 2;
      let end = start;
      while (end < pairs.length && !(pairs[end][0] === 0 && pairs[end][1] === "ENDSEC")) end++;
      out.set(name, pairs.slice(start, end));
      i = end;
    }
  }
  return out;
}

function entities(pairs: Pair[]): Entity[] {
  const out: Entity[] = [];
  let current: Entity | null = null;
  for (const pair of pairs) {
    if (pair[0] === 0) {
      current = { type: pair[1], layer: "0", data: [] };
      out.push(current);
    } else if (current) {
      if (pair[0] === 8) current.layer = pair[1];
      current.data.push(pair);
    }
  }
  return out;
}

const num = (e: Entity, code: number, fallback = 0) => {
  const hit = e.data.find((p) => p[0] === code);
  return hit ? Number.parseFloat(hit[1]) : fallback;
};
const str = (e: Entity, code: number) => e.data.find((p) => p[0] === code)?.[1] ?? "";

/** Points along a bulged segment from a to b, excluding a. */
function bulgePoints(a: Pt, b: Pt, bulge: number): Pt[] {
  if (Math.abs(bulge) < 1e-9) return [b];
  const theta = 4 * Math.atan(bulge);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return [b];
  const h = c / 2 / Math.tan(theta / 2);
  const cx = (a[0] + b[0]) / 2 - (h * dy) / c;
  const cy = (a[1] + b[1]) / 2 + (h * dx) / c;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  const start = Math.atan2(a[1] - cy, a[0] - cx);
  const n = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 24)));
  const pts: Pt[] = [];
  for (let k = 1; k < n; k++) {
    const t = start + (theta * k) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  pts.push(b);
  return pts;
}

function withBulges(vertices: { p: Pt; bulge: number }[], closed: boolean): Pt[] {
  if (!vertices.length) return [];
  const pts: Pt[] = [vertices[0].p];
  const count = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < count; i++) {
    const next = vertices[(i + 1) % vertices.length].p;
    const seg = bulgePoints(vertices[i].p, next, vertices[i].bulge);
    if (closed && i === count - 1) seg.pop(); // The ring closes on its first point.
    pts.push(...seg);
  }
  return pts;
}

function arcPoints(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): Pt[] {
  const n = Math.max(2, Math.ceil(Math.abs(sweepDeg) / 7.5));
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = ((startDeg + (sweepDeg * k) / n) * Math.PI) / 180;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as Pt;
  });
}

function shapesOf(list: Entity[], blocks: Map<string, Entity[]>, name: string, depth: number): Shape[] {
  const shapes: Shape[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    switch (e.type) {
      case "LWPOLYLINE": {
        const vertices: { p: Pt; bulge: number }[] = [];
        for (const [code, value] of e.data) {
          if (code === 10) vertices.push({ p: [Number.parseFloat(value), 0], bulge: 0 });
          else if (code === 20 && vertices.length) vertices[vertices.length - 1].p[1] = Number.parseFloat(value);
          else if (code === 42 && vertices.length) vertices[vertices.length - 1].bulge = Number.parseFloat(value);
        }
        const closed = (num(e, 70) & 1) === 1;
        shapes.push({ name, layer: e.layer, points: withBulges(vertices, closed), closed });
        break;
      }
      case "POLYLINE": {
        const closed = (num(e, 70) & 1) === 1;
        const vertices: { p: Pt; bulge: number }[] = [];
        let j = i + 1;
        for (; j < list.length && list[j].type !== "SEQEND"; j++) {
          if (list[j].type === "VERTEX") vertices.push({ p: [num(list[j], 10), num(list[j], 20)], bulge: num(list[j], 42) });
        }
        i = j;
        shapes.push({ name, layer: e.layer, points: withBulges(vertices, closed), closed });
        break;
      }
      case "CIRCLE": {
        const pts = arcPoints(num(e, 10), num(e, 20), num(e, 40), 0, 360);
        pts.pop();
        shapes.push({ name, layer: e.layer, points: pts, closed: true });
        break;
      }
      case "ELLIPSE": {
        const cx = num(e, 10);
        const cy = num(e, 20);
        const mx = num(e, 11);
        const my = num(e, 21);
        const ratio = num(e, 40, 1);
        const t0 = num(e, 41, 0);
        let t1 = num(e, 42, 2 * Math.PI);
        if (t1 <= t0) t1 += 2 * Math.PI;
        const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6;
        const n = 64;
        const pts: Pt[] = [];
        for (let k = 0; k <= (full ? n - 1 : n); k++) {
          const t = t0 + ((t1 - t0) * k) / n;
          pts.push([cx + mx * Math.cos(t) - my * ratio * Math.sin(t), cy + my * Math.cos(t) + mx * ratio * Math.sin(t)]);
        }
        shapes.push({ name, layer: e.layer, points: pts, closed: full });
        break;
      }
      case "LINE":
        shapes.push({ name, layer: e.layer, points: [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]], closed: false });
        break;
      case "ARC": {
        const start = num(e, 50);
        let sweep = (num(e, 51) - start) % 360;
        if (sweep <= 0) sweep += 360;
        shapes.push({ name, layer: e.layer, points: arcPoints(num(e, 10), num(e, 20), num(e, 40), start, sweep), closed: false });
        break;
      }
      case "INSERT": {
        const block = blocks.get(str(e, 2));
        if (!block || depth > 4) break;
        const ox = num(e, 10);
        const oy = num(e, 20);
        const sx = num(e, 41, 1);
        const sy = num(e, 42, 1);
        const rot = (num(e, 50) * Math.PI) / 180;
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        for (const shape of shapesOf(block, blocks, str(e, 2), depth + 1)) {
          shapes.push({
            ...shape,
            points: shape.points.map(([x, y]) => [ox + c * x * sx - s * y * sy, oy + s * x * sx + c * y * sy]),
          });
        }
        break;
      }
    }
  }
  return shapes;
}

/** Joins open segments end to end into closed loops; leftovers (grain lines, notches) are dropped. */
function chain(open: Shape[], tol: number): Shape[] {
  const near = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  const pool = open.filter((s) => s.points.length >= 2);
  const loops: Shape[] = [];
  while (pool.length) {
    const first = pool.pop()!;
    const pts = [...first.points];
    let grew = true;
    while (grew && !(pts.length > 2 && near(pts[0], pts[pts.length - 1]))) {
      grew = false;
      const tail = pts[pts.length - 1];
      for (let k = 0; k < pool.length; k++) {
        const seg = pool[k].points;
        if (near(seg[0], tail)) pts.push(...seg.slice(1));
        else if (near(seg[seg.length - 1], tail)) pts.push(...[...seg].reverse().slice(1));
        else continue;
        pool.splice(k, 1);
        grew = true;
        break;
      }
    }
    if (pts.length > 3 && near(pts[0], pts[pts.length - 1])) {
      pts.pop();
      loops.push({ ...first, points: pts, closed: true });
    }
  }
  return loops;
}

export function parseDxfInBrowser(text: string): Piece[] {
  const pairs = readPairs(text);
  const secs = sections(pairs);
  const header = secs.get("HEADER") ?? [];
  const unitIndex = header.findIndex((p) => p[0] === 9 && p[1] === "$INSUNITS");
  const unit = unitIndex >= 0 ? INSUNITS_MM[Number.parseInt(header[unitIndex + 1]?.[1] ?? "4", 10)] ?? 1 : 1;

  const blocks = new Map<string, Entity[]>();
  let block: Entity[] | null = null;
  for (const e of entities(secs.get("BLOCKS") ?? [])) {
    if (e.type === "BLOCK") {
      block = [];
      blocks.set(str(e, 2), block);
    } else if (e.type === "ENDBLK") {
      block = null;
    } else if (block) {
      block.push(e);
    }
  }

  let shapes = shapesOf(entities(secs.get("ENTITIES") ?? []), blocks, "", 0);
  // AAMA/ASTM pattern files put cut lines on layer 1 and inner cut-outs on layer 11; their other
  // layers (grain, notches, drill holes, annotations) are not cut.
  if (shapes.some((s) => s.layer === "1")) shapes = shapes.filter((s) => s.layer === "1" || s.layer === "11");
  // CutZero's own exports carry the roll outline and the flaws on layers that are not parts.
  shapes = shapes.filter((s) => s.layer !== "ROLL" && s.layer !== "DEFECTS");
  shapes = shapes.map((s) => ({ ...s, points: s.points.map(([x, y]) => [x * unit, -y * unit] as Pt) }));

  const closed = [...shapes.filter((s) => s.closed && s.points.length >= 3), ...chain(shapes.filter((s) => !s.closed), CHAIN_TOL)];
  if (!closed.length) throw new Error("No closed outlines were found in this DXF.");
  let n = 0;
  return piecesFromRings(closed.map((s) => ({ name: s.name || `Part ${++n}`, ring: s.points })));
}
