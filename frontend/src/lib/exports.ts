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
  defects: Pt[][] = [],
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
    ...(defects.length
      ? [`<g id="defects-do-not-cut" fill="#ef4444" fill-opacity="0.35" stroke="#ef4444" stroke-width="0.5">`, ...defects.map((d) => `<path d="${path(d)}"/>`), `</g>`]
      : []),
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

/** AutoCAD R12 DXF in millimetres, matching backend/app/exporter.py: closed POLYLINEs on layers
 *  ROLL, CUT_OUTER, CUT_INNER and DEFECTS, which cutting-room CAM software maps to tools. */
export function exportDxf(name: string, pieces: Piece[], layout: Placement[], rollWidth: number, length: number, kerf: number, defects: Pt[][] = []): string {
  const out: string[] = [];
  const pair = (code: number, value: string | number) => out.push(String(code), typeof value === "number" && !Number.isInteger(value) ? value.toFixed(3) : String(value));
  const coord = (code: number, v: number) => out.push(String(code), v.toFixed(3));
  const polyline = (layer: string, ring: Pt[]) => {
    pair(0, "POLYLINE");
    pair(8, layer);
    pair(66, 1);
    pair(70, 1);
    for (const [x, y] of ring) {
      pair(0, "VERTEX");
      pair(8, layer);
      coord(10, x);
      coord(20, y);
    }
    pair(0, "SEQEND");
    pair(8, layer);
  };
  const byId = new Map(pieces.map((p) => [p.id, p]));
  pair(999, `CutZero nested marker: ${name} | ${length.toFixed(1)} x ${rollWidth.toFixed(1)} mm | kerf ${kerf} mm`);
  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$INSUNITS");
  pair(70, 4);
  pair(9, "$EXTMIN");
  coord(10, 0);
  coord(20, 0);
  pair(9, "$EXTMAX");
  coord(10, length);
  coord(20, rollWidth);
  pair(0, "ENDSEC");
  pair(0, "SECTION");
  pair(2, "ENTITIES");
  polyline("ROLL", [[0, 0], [length, 0], [length, rollWidth], [0, rollWidth]]);
  for (const pl of layout) {
    const piece = byId.get(pl.id)!;
    polyline("CUT_OUTER", worldRing(piece.outer, pl));
    for (const h of piece.holes) polyline("CUT_INNER", worldRing(h, pl));
  }
  for (const d of defects) polyline("DEFECTS", d);
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return out.join("\n") + "\n";
}
