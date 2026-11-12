import { useState } from "react";
import type { EngineClient } from "../engine/client";
import type { CompleteFrame, Impact, JobHistory, ProgressFrame } from "../types";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="num truncate text-xs text-ink-200">{value}</dd>
    </div>
  );
}

export function EngineCard({
  frame,
  complete,
  engine,
  fps,
}: {
  frame: ProgressFrame | CompleteFrame | null;
  complete: CompleteFrame | null;
  engine: EngineClient;
  fps: number;
}) {
  const progress = frame?.type === "progress" ? frame : null;
  const s = complete?.stats;
  const evals = s?.evaluations ?? progress?.evaluations ?? 0;
  const elapsed = complete?.elapsed_ms ?? progress?.elapsed_ms ?? 0;
  return (
    <section>
      <h3 className="label mb-1">Engine telemetry</h3>
      <dl>
        <Row label="Engine" value={engine.label} />
        <Row label="Phase" value={complete ? "complete" : progress?.phase ?? "idle"} />
        <Row label="Temperature" value={progress ? progress.temperature.toFixed(1) : "–"} />
        <Row label="Layouts evaluated" value={evals ? evals.toLocaleString("en-US") : "–"} />
        <Row label="Solve time" value={elapsed ? `${(elapsed / 1000).toFixed(2)} s` : "–"} />
        <Row label="FFT correlation" value={s ? `${s.avg_fft_ms.toFixed(2)} ms avg` : "–"} />
        <Row label="Full layout decode" value={s ? `${s.avg_eval_ms.toFixed(1)} ms avg` : "–"} />
        <Row label="Search grid" value={s ? `${s.grid_rows}×${s.grid_cols} at ${s.cell_mm.toFixed(1)} mm` : "–"} />
        <Row label="Parallel chains" value={s ? String(s.threads) : "–"} />
        <Row label="Canvas" value={fps ? `${fps} fps` : "–"} />
      </dl>
    </section>
  );
}

export function VerificationCard({ complete }: { complete: CompleteFrame | null }) {
  if (!complete) {
    return (
      <section>
        <h3 className="label mb-1">Independent check</h3>
        <p className="text-xs leading-relaxed text-ink-400">
          After each run, a separate checker that shares no code with the engine rebuilds every part and measures the gaps.
        </p>
      </section>
    );
  }
  const v = complete.verification;
  return (
    <section>
      <h3 className="label mb-1">Independent check</h3>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold text-ink-950 ${v.valid ? "bg-saved" : "bg-waste"}`}
        >
          {v.valid ? "✓" : "!"}
        </span>
        <span className="text-sm font-medium text-ink-100">{v.valid ? "No overlaps. Ready to cut." : "Layout failed verification"}</span>
      </div>
      <dl className="mt-1.5">
        <Row label="Tightest gap found" value={v.min_clearance_mm !== null ? `${v.min_clearance_mm.toFixed(3)} mm` : "–"} />
        <Row label="Required kerf" value={`${v.kerf_mm} mm`} />
        <Row label="Parts checked" value={String(v.pieces_checked)} />
        <Row label="Close pairs measured" value={String(v.pairs_checked)} />
        <Row label="Interlocked pairs" value={String(complete.engine_validation.interlocks)} />
      </dl>
      {v.problems.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs text-waste">
          {v.problems.slice(0, 5).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Assumption({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(v: number): void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs text-ink-300">
        {label}
        <span className="num text-ink-100">
          {value.toLocaleString("en-US")} {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full"
      />
    </label>
  );
}

/** Scales the measured per-lay saving by the user's own factory assumptions. */
export function ImpactPanel({
  impact,
  gsm,
  co2Factor,
  isMetal,
}: {
  impact: Impact | null;
  gsm: number;
  co2Factor: number;
  isMetal: boolean;
}) {
  const [lays, setLays] = useState(20);
  const [days, setDays] = useState(250);
  const [price, setPrice] = useState(isMetal ? 12 : 4);

  const totalLays = lays * days;
  const area = (impact?.area_saved_m2 ?? 0) * totalLays;
  const kg = area * (gsm / 1000);
  const co2 = kg * co2Factor;
  const money = area * price;

  const base = impact?.scrap_area_baseline_m2 ?? 0;
  const opt = impact?.scrap_area_optimized_m2 ?? 0;
  const maxScrap = Math.max(base, 0.001);

  return (
    <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-[1.1fr_1fr_1.1fr]">
      <div>
        <h3 className="text-sm font-semibold text-ink-100">Offcut per lay</h3>
        <p className="mt-0.5 text-xs text-ink-400">Material left behind after the parts are cut, for the same parts on the same roll.</p>
        <div className="mt-3 flex flex-col gap-2.5">
          {[
            { name: "Bounding-box baseline", value: base, color: "bg-waste" },
            { name: "CutZero", value: opt, color: "bg-saved" },
          ].map((bar) => (
            <div key={bar.name}>
              <div className="flex justify-between text-xs">
                <span className="text-ink-300">{bar.name}</span>
                <span className="num text-ink-100">{impact ? `${bar.value.toFixed(2)} m²` : "–"}</span>
              </div>
              <div className="mt-1 h-2 rounded bg-ink-800">
                <div
                  className={`h-2 rounded ${bar.color} transition-[width] duration-300`}
                  style={{ width: impact ? `${(bar.value / maxScrap) * 100}%` : "0%" }}
                />
              </div>
            </div>
          ))}
        </div>
        {impact && base > 0 && (
          <p className="mt-3 text-sm text-ink-200">
            <span className="num font-semibold text-saved">{(100 * (1 - opt / base)).toFixed(0)}%</span> less offcut on every lay.
          </p>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-ink-100">Scale it to your factory</h3>
        <p className="mt-0.5 text-xs text-ink-400">Your assumptions, applied to this run's measured saving.</p>
        <div className="mt-3 flex flex-col gap-2.5">
          <Assumption label="Lays cut per day" unit="" value={lays} min={1} max={200} step={1} onChange={setLays} />
          <Assumption label="Working days per year" unit="" value={days} min={50} max={365} step={5} onChange={setDays} />
          <Assumption label="Material cost" unit="$/m²" value={price} min={0.5} max={60} step={0.5} onChange={setPrice} />
        </div>
      </div>

      <div className="rounded-lg bg-ink-850 p-4">
        <h3 className="label">Each year, from one cutting table</h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
          {[
            { label: "Material not bought", value: impact ? `${Math.round(area).toLocaleString("en-US")} m²` : "–" },
            { label: "Scrap not landfilled", value: impact ? `${(kg / 1000).toFixed(1)} t` : "–" },
            { label: "Carbon avoided", value: impact ? `${(co2 / 1000).toFixed(1)} t CO2e` : "–" },
            { label: "Material cost saved", value: impact ? `$${Math.round(money).toLocaleString("en-US")}` : "–" },
          ].map((item) => (
            <div key={item.label}>
              <dt className="text-xs text-ink-400">{item.label}</dt>
              <dd className="num text-lg font-semibold text-ink-100">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function HistoryPanel({ history, exportUrl }: { history: JobHistory | null; exportUrl(id: string, kind: "svg" | "gcode"): string | null }) {
  if (!history) {
    return (
      <p className="text-xs text-ink-400">
        Run history needs the server. This session is using the in-browser engine, which keeps nothing after you close the tab.
      </p>
    );
  }
  const { jobs, aggregate } = history;
  return (
    <div>
      <p className="text-sm text-ink-200">
        <span className="num font-semibold text-ink-100">{aggregate.runs.toLocaleString("en-US")}</span> runs recorded in {aggregate.backend === "postgresql" ? "PostgreSQL" : "SQLite"}, adding up to{" "}
        <span className="num font-semibold text-saved">{aggregate.waste_saved_kg.toFixed(1)} kg</span> of scrap prevented and an average gain of{" "}
        <span className="num font-semibold text-ink-100">+{aggregate.avg_utilization_gain_pct.toFixed(1)} pts</span>.
      </p>
      {jobs.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-xs">
            <thead>
              <tr className="text-ink-400">
                <th className="pb-1.5 font-medium">Run</th>
                <th className="pb-1.5 text-right font-medium">Parts</th>
                <th className="pb-1.5 text-right font-medium">Utilization</th>
                <th className="pb-1.5 text-right font-medium">Saved per lay</th>
                <th className="pb-1.5 text-right font-medium">Batch scrap saved</th>
                <th className="pb-1.5 text-right font-medium">Solve</th>
                <th className="pb-1.5 text-right font-medium">Files</th>
              </tr>
            </thead>
            <tbody className="num">
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-ink-800 text-ink-200">
                  <td className="truncate py-1.5 pr-2 font-sans">{j.name}</td>
                  <td className="py-1.5 text-right">{j.piece_count}</td>
                  <td className="py-1.5 text-right">
                    {j.baseline_utilization_pct.toFixed(1)} → {j.optimized_utilization_pct.toFixed(1)}%
                  </td>
                  <td className="py-1.5 text-right">{j.linear_saved_m.toFixed(3)} m</td>
                  <td className="py-1.5 text-right">{j.waste_saved_kg_per_batch.toFixed(1)} kg</td>
                  <td className="py-1.5 text-right">{(j.solve_ms / 1000).toFixed(1)} s</td>
                  <td className="py-1.5 text-right font-sans">
                    <a className="underline underline-offset-2 hover:text-ink-100" href={exportUrl(j.id, "svg") ?? "#"}>
                      SVG
                    </a>{" "}
                    <a className="underline underline-offset-2 hover:text-ink-100" href={exportUrl(j.id, "gcode") ?? "#"}>
                      G-code
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function HowItWorks() {
  const steps = [
    {
      title: "1. FFT radar scan",
      body: "The roll and each part become grids. One 2D FFT cross-correlation checks every position on the roll at once, instead of testing them one by one.",
    },
    {
      title: "2. Exact slide-and-lock",
      body: "The best pockets get re-checked on true vector geometry. Each part slides until it touches its neighbours, stopping at the blade's kerf clearance.",
    },
    {
      title: "3. Simulated annealing",
      body: "Parallel searches try thousands of placement orders and rotations, sometimes accepting a worse layout to escape dead ends, and share their best results.",
    },
  ];
  return (
    <section className="grid gap-4 md:grid-cols-3">
      {steps.map((s) => (
        <div key={s.title}>
          <h3 className="text-sm font-semibold text-ink-100">{s.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-300">{s.body}</p>
        </div>
      ))}
    </section>
  );
}

export function MethodNote() {
  return (
    <details className="text-xs leading-relaxed text-ink-400">
      <summary className="cursor-pointer font-medium text-ink-300">How these numbers are calculated, and what they don't claim</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        <li>Utilization η is true part area (Shoelace formula) divided by roll width × used length.</li>
        <li>
          Scrap prevented = roll saved × material weight × batch count. Carbon uses 15.2 kg CO2e/kg for woven textiles and 11.5 kg CO2e/kg for sheet aluminium, the project's stated factors.
        </li>
        <li>
          The baseline is the best of nine First-Fit Decreasing shelf-packing variants on bounding boxes, under the same kerf and rotation rules. It stands in for simple nesting tools. Commercial marker software will beat it, so the gain here doesn't measure CutZero against those products.
        </li>
        <li>The factory projection multiplies this one run by your assumptions. It isn't a measurement from a real production line.</li>
      </ul>
    </details>
  );
}
