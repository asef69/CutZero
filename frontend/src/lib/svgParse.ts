import type { Piece, Pt } from "../types";

// Browser SVG import for runs with no server. The DOM does the curve maths: real geometry
// elements report points along their outline, with transforms resolved through getCTM().

const MAX_VERTICES = 80;
const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 };
const SVG_NS = "http://www.w3.org/2000/svg";

function signedArea(ring: Pt[]): number {
  let t = 0;
  ring.forEach(([x0, y0], i) => {
    const [x1, y1] = ring[(i + 1) % ring.length];
    t += x0 * y1 - x1 * y0;
  });
  return t / 2;
}

function perpendicular(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len;
}

function simplifyOpen(points: Pt[], eps: number): Pt[] {
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let best = 0;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicular(points[i], points[lo], points[hi]);
      if (d > best) {
        best = d;
        at = i;
      }
    }
    if (best > eps && at > 0) {
      keep[at] = true;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function simplifyRing(ring: Pt[], eps: number): Pt[] {
  if (ring.length < 4) return ring;
  const far = (from: Pt) => {
    let best = 0;
    let at = 0;
    ring.forEach((p, i) => {
      const d = Math.hypot(p[0] - from[0], p[1] - from[1]);
      if (d > best) {
        best = d;
        at = i;
      }
    });
    return at;
  };
  const b = far(ring[0]);
  const a = far(ring[b]);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const first = simplifyOpen(ring.slice(lo, hi + 1), eps);
  const second = simplifyOpen([...ring.slice(hi), ...ring.slice(0, lo + 1)], eps);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function toBudget(ring: Pt[]): Pt[] {
  let eps = 0.25;
  let out = simplifyRing(ring, eps);
  while (out.length > MAX_VERTICES && eps < 50) {
    eps *= 1.5;
    out = simplifyRing(ring, eps);
  }
  return out;
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

function rootScale(svg: Element): number {
  const match = (svg.getAttribute("width") ?? "").match(/^\s*([\d.]+)\s*([a-zA-Z]+)\s*$/);
  const box = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (match && UNIT_MM[match[2].toLowerCase()] && box?.length === 4 && box[2] > 0) {
    return (parseFloat(match[1]) * UNIT_MM[match[2].toLowerCase()]) / box[2];
  }
  return 1; // Without physical units, 1 user unit is taken as 1 mm.
}

export function parseSvgInBrowser(text: string): Piece[] {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const source = doc.documentElement;
  if (source.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    throw new Error("This file could not be read as SVG.");
  }
  // Scripts and event handlers never run: only whitelisted geometry attributes are copied over.
  const host = document.createElementNS(SVG_NS, "svg");
  host.setAttribute("width", "0");
  host.setAttribute("height", "0");
  host.style.position = "absolute";
  document.body.appendChild(host);

  const scale = rootScale(source);
  const rings: { name: string; ring: Pt[] }[] = [];
  try {
    for (const el of Array.from(source.querySelectorAll("path,polygon,polyline,rect,circle,ellipse"))) {
      if (el.closest("defs,clipPath,mask,symbol,pattern,marker")) continue;
      const chain: string[] = [];
      for (let n: Element | null = el; n && n !== source; n = n.parentElement) {
        const t = n.getAttribute("transform");
        if (t) chain.unshift(t);
      }
      const shape = document.createElementNS(SVG_NS, el.localName) as SVGGeometryElement;
      for (const a of ["d", "points", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r"]) {
        const v = el.getAttribute(a);
        if (v !== null) shape.setAttribute(a, v);
      }
      if (chain.length) shape.setAttribute("transform", chain.join(" "));
      host.appendChild(shape);

      const total = shape.getTotalLength();
      if (!(total > 0)) {
        shape.remove();
        continue;
      }
      const local = shape.transform.baseVal.consolidate()?.matrix;
      const apply = (x: number, y: number): Pt =>
        local
          ? [(local.a * x + local.c * y + local.e) * scale, (local.b * x + local.d * y + local.f) * scale]
          : [x * scale, y * scale];
      const step = Math.max(total / 1500, 0.5);
      let current: Pt[] = [];
      const flush = () => {
        if (current.length >= 3) rings.push({ name: el.id || el.localName, ring: current });
        current = [];
      };
      let prev: DOMPoint | null = null;
      for (let d = 0; d <= total + 1e-6; d += step) {
        const p = shape.getPointAtLength(Math.min(d, total));
        // getPointAtLength walks subpaths in order, so a jump marks the start of the next one.
        if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > step * 3) flush();
        current.push(apply(p.x, p.y));
        prev = p;
      }
      flush();
      shape.remove();
    }
  } finally {
    host.remove();
  }

  const cleaned = rings
    .map(({ name, ring }) => ({ name, ring: toBudget(ring) }))
    .filter(({ ring }) => ring.length >= 3 && Math.abs(signedArea(ring)) >= 1);
  if (!cleaned.length) throw new Error("No closed shapes were found in this file.");
  cleaned.sort((a, b) => Math.abs(signedArea(b.ring)) - Math.abs(signedArea(a.ring)));

  const pieces: { name: string; outer: Pt[]; holes: Pt[][] }[] = [];
  const depth = cleaned.map(() => 0);
  const parent = cleaned.map(() => -1);
  cleaned.forEach(({ ring }, i) => {
    for (let j = 0; j < i; j++) {
      if (inRing(ring[0], cleaned[j].ring)) {
        depth[i] += 1;
        parent[i] = j;
      }
    }
  });
  const indexOf = new Map<number, number>();
  cleaned.forEach(({ name, ring }, i) => {
    if (depth[i] % 2 === 0) {
      indexOf.set(i, pieces.length);
      pieces.push({ name, outer: signedArea(ring) >= 0 ? ring : [...ring].reverse(), holes: [] });
    }
  });
  cleaned.forEach(({ ring }, i) => {
    if (depth[i] % 2 === 1 && indexOf.has(parent[i])) {
      pieces[indexOf.get(parent[i])!].holes.push(signedArea(ring) <= 0 ? ring : [...ring].reverse());
    }
  });

  return pieces.map((piece, id) => {
    const minX = Math.min(...piece.outer.map((p) => p[0]));
    const minY = Math.min(...piece.outer.map((p) => p[1]));
    const shift = (ring: Pt[]): Pt[] => ring.map(([x, y]) => [x - minX, y - minY]);
    const outer = shift(piece.outer);
    const holes = piece.holes.map(shift);
    const area = Math.abs(signedArea(outer)) - holes.reduce((t, h) => t + Math.abs(signedArea(h)), 0);
    return { id, name: piece.name, outer, holes, area_mm2: area };
  });
}
