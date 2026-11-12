import type { CompleteFrame, JobRequest, Piece, Placement, Pt } from "../types";
import { downloadText } from "./exports";
import { ringBounds, worldRing } from "./geometry";

// A one-page cutting-room report that a production manager can print or save as PDF: both
// markers drawn to scale, the measured savings, and the independent verification result.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number, digits = 1) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function marker(pieces: Piece[], layout: Placement[], rollWidth: number, length: number, drawLength: number, defects: Pt[][], boxes: boolean): string {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const path = (ring: Pt[]) => `M${ring.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}Z`;
  const parts: string[] = [];
  for (const pl of layout) {
    const piece = byId.get(pl.id);
    if (!piece) continue;
    const outer = worldRing(piece.outer, pl);
    if (boxes) {
      const b = ringBounds(outer);
      parts.push(`<rect x="${b.minX.toFixed(1)}" y="${b.minY.toFixed(1)}" width="${(b.maxX - b.minX).toFixed(1)}" height="${(b.maxY - b.minY).toFixed(1)}" fill="#fde2e7" stroke="#e11d48" stroke-width="2"/>`);
    }
    const d = path(outer) + piece.holes.map((h) => path(worldRing(h, pl))).join("");
    parts.push(`<path d="${d}" fill="${boxes ? "#94a3b8" : "#34d399"}" fill-rule="evenodd" stroke="#0f172a" stroke-width="1.5"/>`);
  }
  for (const flaw of defects) parts.push(`<path d="${path(flaw)}" fill="#ef4444" stroke="#7f1d1d" stroke-width="2"/>`);
  return `<svg viewBox="0 0 ${drawLength.toFixed(0)} ${rollWidth.toFixed(0)}" preserveAspectRatio="xMinYMin meet">
<rect x="0" y="0" width="${drawLength.toFixed(0)}" height="${rollWidth.toFixed(0)}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="3"/>
${length < drawLength ? `<rect x="${length.toFixed(0)}" y="0" width="${(drawLength - length).toFixed(0)}" height="${rollWidth.toFixed(0)}" fill="#d1fae5"/>` : ""}
${parts.join("\n")}
<line x1="${length.toFixed(0)}" y1="0" x2="${length.toFixed(0)}" y2="${rollWidth.toFixed(0)}" stroke="${boxes ? "#e11d48" : "#059669"}" stroke-width="8"/>
</svg>`;
}

export function openReport(job: JobRequest, complete: CompleteFrame, engineLabel: string): void {
  const c = complete;
  const v = c.verification;
  const drawLength = Math.max(c.baseline_length_mm, c.optimized_length_mm);
  const area = job.pieces.reduce((t, p) => t + p.area_mm2, 0) / 1e6;
  const rows: [string, string, string][] = [
    ["Roll length per lay", `${num(c.baseline_length_mm, 0)} mm`, `${num(c.optimized_length_mm, 0)} mm`],
    ["Material utilization (η)", `${num(c.baseline_utilization_pct, 1)}%`, `${num(c.optimized_utilization_pct, 1)}%`],
    ["Offcut area per lay", `${num(c.scrap_area_baseline_m2, 2)} m²`, `${num(c.scrap_area_optimized_m2, 2)} m²`],
  ];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CutZero report: ${esc(job.name)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  :root { color-scheme: light; }
  html, body { background: #ffffff; }
  body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; margin: 24px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #475569; margin: 18px 0 6px; }
  .sub { color: #475569; margin-top: 2px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
  .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
  .kpi b { display: block; font-size: 22px; color: #047857; font-variant-numeric: tabular-nums; }
  .kpi span { color: #475569; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  td, th { border-bottom: 1px solid #e2e8f0; padding: 5px 8px; text-align: right; } td:first-child, th:first-child { text-align: left; }
  .marker svg { width: 100%; height: auto; max-height: 230px; display: block; }
  @media print { .marker svg { max-height: 62mm; } }
  .label { font-size: 12px; color: #475569; margin: 8px 0 3px; }
  .ok { color: #047857; font-weight: 600; } .bad { color: #b91c1c; font-weight: 600; }
  .note { color: #64748b; font-size: 11px; margin-top: 14px; }
  .print { position: fixed; top: 16px; right: 16px; padding: 8px 14px; border-radius: 6px; border: 0; background: #059669; color: white; font-weight: 600; cursor: pointer; }
  @media print { .print { display: none; } body { margin: 0; } }
</style></head><body>
<button class="print" onclick="window.print()">Print / save as PDF</button>
<h1>Cutting-room nesting report: ${esc(job.name)}</h1>
<div class="sub">${job.pieces.length} parts · ${num(area, 2)} m² of parts · roll ${num(job.roll_width_mm, 0)} mm · kerf ${job.kerf_mm} mm · ${job.defects.length} marked flaw${job.defects.length === 1 ? "" : "s"} · batch of ${job.batch_count.toLocaleString("en-US")} lays · ${new Date().toLocaleString()}</div>
<div class="kpis">
  <div class="kpi"><b>+${num(c.utilization_gain_pct, 1)} pts</b><span>utilization, ${num(c.baseline_utilization_pct, 1)}% → ${num(c.optimized_utilization_pct, 1)}%</span></div>
  <div class="kpi"><b>${num(c.linear_saved_m_per_batch, 1)} m</b><span>roll saved per batch (${num(c.area_saved_m2_per_batch, 1)} m²)</span></div>
  <div class="kpi"><b>${num(c.waste_saved_kg_per_batch, 1)} kg</b><span>scrap prevented per batch at ${job.fabric_gsm} g/m²</span></div>
  <div class="kpi"><b>${num(c.co2_saved_kg_per_batch, 0)} kg</b><span>CO2e avoided per batch at ${job.co2_factor_kg_per_kg} kg CO2e/kg</span></div>
</div>
<h2>Markers, drawn to the same scale</h2>
<div class="label">Baseline: first-fit decreasing bounding boxes (red boxes are the boxes being packed)</div>
<div class="marker">${marker(job.pieces, c.baseline_layout, job.roll_width_mm, c.baseline_length_mm, drawLength, job.defects, true)}</div>
<div class="label">CutZero nest (green band: roll no longer used)</div>
<div class="marker">${marker(job.pieces, c.optimized_layout, job.roll_width_mm, c.optimized_length_mm, drawLength, job.defects, false)}</div>
<h2>Per lay</h2>
<table><tr><th></th><th>Baseline</th><th>CutZero</th></tr>${rows.map(([a, b, d]) => `<tr><td>${a}</td><td>${b}</td><td>${d}</td></tr>`).join("")}</table>
<h2>Verification</h2>
<p>${v.valid ? `<span class="ok">Passed.</span>` : `<span class="bad">Failed: ${esc(v.problems.join("; "))}</span>`} The ${esc(v.verifier)} rebuilt all ${v.pieces_checked} parts from the raw outlines${job.defects.length ? ` and ${job.defects.length} flaws` : ""}, measured ${v.pairs_checked} close pairs, and found a tightest gap of ${v.min_clearance_mm !== null ? num(v.min_clearance_mm, 3) : "–"} mm against a ${v.kerf_mm} mm kerf. ${c.engine_validation.interlocks} pairs of parts interlock, which a bounding-box layout cannot do.</p>
<p class="note">Engine: ${esc(engineLabel)}, ${c.max_iterations} annealing iterations, solved in ${num(c.stats.solve_ms / 1000, 2)} s. The baseline is the best of nine first-fit decreasing shelf-packing variants under the same kerf, rotation and flaw rules; commercial marker software will beat it, so these savings are against simple box-style layouts. Scrap = roll no longer consumed × batch × material weight. Generated by CutZero.</p>
</body></html>`;
  const win = window.open("", "_blank");
  if (!win) {
    // Popup blocked: hand the report over as a file instead.
    downloadText(`cutzero-report-${job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.html`, html, "text/html");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

