import type { Piece, Placement, Pt } from "../types";
import { worldRing } from "./geometry";

// Client-side counterparts of backend/app/exporter.py. Used for the serverless engine, and the
// cut order also drives the toolpath animation.

export interface Contour {
  label: string;
  ring: Pt[];
}

/** Inner cuts first, since a freed part can shift on the bed; pieces visited nearest-neighbour. */
export function cutOrder(pieces: Piece[], layout: Placement[]): Contour[] {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const remaining = layout.map((pl) => {
    const piece = byId.get(pl.id)!;
    return { name: piece.name, outer: worldRing(piece.outer, pl), holes: piece.holes.map((h) => worldRing(h, pl)) };
  });
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let pos: Pt = [0, 0];
  const out: Contour[] = [];
  while (remaining.length) {
    let best = 0;
    remaining.forEach((r, i) => {
      if (dist(pos, r.outer[0]) < dist(pos, remaining[best].outer[0])) best = i;
    });
    const [item] = remaining.splice(best, 1);
    const holes = [...item.holes];
    let n = 0;
    while (holes.length) {
      let k = 0;
      holes.forEach((h, i) => {
        if (dist(pos, h[0]) < dist(pos, holes[k][0])) k = i;
      });
      const [ring] = holes.splice(k, 1);
      n += 1;
      out.push({ label: `${item.name} / cut-out ${n}`, ring });
      pos = ring[0];
    }
    out.push({ label: `${item.name} / outline`, ring: item.outer });
    pos = item.outer[0];
  }
  return out;
}

export function exportSvg(
  name: string,
  pieces: Piece[],
  layout: Placement[],
  rollWidth: number,
  length: number,
  utilization: number,
  kerf: number,
): string {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const path = (ring: Pt[]) => `M${ring.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join("L")}Z`;
  const body = layout.map((pl) => {
    const piece = byId.get(pl.id)!;
    const d = path(worldRing(piece.outer, pl)) + piece.holes.map((h) => path(worldRing(h, pl))).join("");
    return `<path id="piece-${piece.id}" data-name="${esc(piece.name)}" data-rotation="${pl.rotation_deg}" d="${d}"/>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- CutZero nested marker: ${esc(name)} | ${length.toFixed(1)} mm x ${rollWidth.toFixed(1)} mm | utilization ${utilization.toFixed(2)}% | kerf ${kerf} mm -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${length.toFixed(3)}mm" height="${rollWidth.toFixed(3)}mm" viewBox="0 0 ${length.toFixed(3)} ${rollWidth.toFixed(3)}">`,
    `<rect id="roll" x="0" y="0" width="${length.toFixed(3)}" height="${rollWidth.toFixed(3)}" fill="none" stroke="#10b981" stroke-width="1"/>`,
    `<g id="cut-paths" fill="none" stroke="#111827" stroke-width="0.5" fill-rule="evenodd">`,
    ...body,
    `</g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

export function exportGcode(
  name: string,
  pieces: Piece[],
  layout: Placement[],
  rollWidth: number,
  length: number,
  kerf: number,
  feed = 3000,
): string {
  const cuts = cutOrder(pieces, layout);
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let cutMm = 0;
  let rapidMm = 0;
  let pos: Pt = [0, 0];
  const body: string[] = [];
  for (const { label, ring } of cuts) {
    rapidMm += dist(pos, ring[0]);
    body.push(`; ${label}`, `G00 X${ring[0][0].toFixed(3)} Y${ring[0][1].toFixed(3)}`, "M03 ; beam on");
    let prev = ring[0];
    for (const pt of [...ring.slice(1), ring[0]]) {
      cutMm += dist(prev, pt);
      body.push(`G01 X${pt[0].toFixed(3)} Y${pt[1].toFixed(3)} F${feed}`);
      prev = pt;
    }
    body.push("M05 ; beam off");
    pos = ring[0];
  }
  rapidMm += dist(pos, [0, 0]);
  const minutes = cutMm / feed + rapidMm / 12000;
  return [
    `; CutZero CNC toolpath: ${name}`,
    `; Sheet: ${length.toFixed(1)} x ${rollWidth.toFixed(1)} mm | kerf ${kerf} mm`,
    `; Pieces: ${layout.length} | contours: ${cuts.length}`,
    `; Cut length: ${(cutMm / 1000).toFixed(2)} m | rapid travel: ${(rapidMm / 1000).toFixed(2)} m | est. ${minutes.toFixed(1)} min`,
    "; Check feed, power and the kerf offset for your machine before cutting.",
    "G21 ; millimetres",
    "G90 ; absolute coordinates",
    "G17 ; XY plane",
    "M05 ; beam off",
    "G00 X0.000 Y0.000",
    ...body,
    "G00 X0.000 Y0.000",
    "M05",
    "M30 ; end of program",
    "",
  ].join("\n");
}

export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
