import { computeImpact } from "../lib/impact";
import { verifyLayout } from "../lib/verify";
import type {
  CompleteFrame,
  EngineStats,
  EngineValidation,
  JobHistory,
  JobRequest,
  Piece,
  Placement,
  Preset,
  ProgressFrame,
  RadarResult,
} from "../types";

export type EngineFrame = ProgressFrame | CompleteFrame;

export interface RunHandle {
  stop(): void;
}

export interface RunCallbacks {
  onFrame(frame: EngineFrame): void;
  onError(message: string): void;
}

export interface EngineClient {
  readonly kind: "server" | "browser";
  readonly label: string;
  readonly detail: string;
  presets(): Promise<Preset[]>;
  run(job: JobRequest, callbacks: RunCallbacks): RunHandle;
  radar(job: JobRequest, layout: Placement[], pieceId: number, rotationDeg: number): Promise<RadarResult>;
  baseline(job: JobRequest): Promise<{ length: number; layout: Placement[] }>;
  history(): Promise<JobHistory | null>;
  parseSvg(file: File): Promise<{ name: string; pieces: Piece[] }>;
  exportUrl(jobId: string, kind: "svg" | "gcode"): string | null;
}

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

function wsUrl(): string {
  if (API) return `${API.replace(/^http/, "ws")}/ws/optimize`;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws/optimize`;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      detail = ((await response.json()) as { detail?: string }).detail ?? detail;
    } catch {
      /* Keep the status message. */
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Native engine behind FastAPI
// ---------------------------------------------------------------------------

export class ServerEngine implements EngineClient {
  readonly kind = "server" as const;
  readonly label = "Native C++20";
  readonly detail = "Compiled engine on the server, streamed over WebSocket";

  async presets(): Promise<Preset[]> {
    return jsonOrThrow<Preset[]>(await fetch(`${API}/api/presets`));
  }

  run(job: JobRequest, { onFrame, onError }: RunCallbacks): RunHandle {
    let finished = false;
    const ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      // Custom pieces are sent in full; presets travel by id.
      const { pieces, preset_id, ...rest } = job;
      ws.send(JSON.stringify({ type: "start_job", ...rest, preset_id, pieces: preset_id ? undefined : pieces }));
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as { type: string; message?: string };
      if (message.type === "error") {
        finished = true;
        onError(message.message ?? "The engine reported an error.");
        ws.close();
      } else if (message.type === "progress") {
        onFrame(message as unknown as EngineFrame);
      } else if (message.type === "complete") {
        finished = true;
        onFrame(message as unknown as EngineFrame);
        ws.close();
      }
    };
    ws.onerror = () => {
      if (!finished) {
        finished = true;
        onError("Could not reach the optimizer stream.");
      }
    };
    ws.onclose = () => {
      if (!finished) {
        finished = true;
        onError("The connection to the optimizer closed mid-run.");
      }
    };
    return {
      stop: () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      },
    };
  }

  async radar(job: JobRequest, layout: Placement[], pieceId: number, rotationDeg: number): Promise<RadarResult> {
    const out = await jsonOrThrow<Omit<RadarResult, "free"> & { free: string }>(
      await fetch(`${API}/api/radar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pieces: job.pieces,
          roll_width_mm: job.roll_width_mm,
          kerf_mm: job.kerf_mm,
          allowed_rotations_deg: job.allowed_rotations_deg,
          layout,
          piece_id: pieceId,
          rotation_deg: rotationDeg,
        }),
      }),
    );
    const binary = atob(out.free);
    const free = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) free[i] = binary.charCodeAt(i);
    return { ...out, free };
  }

  async baseline(job: JobRequest): Promise<{ length: number; layout: Placement[] }> {
    const out = await jsonOrThrow<{ baseline_length_mm: number; baseline_layout: Placement[] }>(
      await fetch(`${API}/api/baseline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pieces: job.pieces,
          roll_width_mm: job.roll_width_mm,
          kerf_mm: job.kerf_mm,
          allowed_rotations_deg: job.allowed_rotations_deg,
        }),
      }),
    );
    return { length: out.baseline_length_mm, layout: out.baseline_layout };
  }

  async history(): Promise<JobHistory | null> {
    return jsonOrThrow<JobHistory>(await fetch(`${API}/api/jobs?limit=8`));
  }

  async parseSvg(file: File): Promise<{ name: string; pieces: Piece[] }> {
    const form = new FormData();
    form.append("file", file);
    return jsonOrThrow(await fetch(`${API}/api/parse-svg`, { method: "POST", body: form }));
  }

  exportUrl(jobId: string, kind: "svg" | "gcode"): string {
    return `${API}/api/jobs/${jobId}/export-${kind}`;
  }
}

// ---------------------------------------------------------------------------
// The same engine compiled to WebAssembly, running in this tab
// ---------------------------------------------------------------------------

function encodeProblem(job: JobRequest, timeLimitMs: number): number[] {
  const out: number[] = [
    job.roll_width_mm,
    job.kerf_mm,
    job.max_iterations,
    job.seed,
    timeLimitMs,
    job.allowed_rotations_deg.length,
    ...job.allowed_rotations_deg,
    job.pieces.length,
  ];
  for (const piece of job.pieces) {
    const rings = [piece.outer, ...piece.holes];
    out.push(rings.length);
    for (const ring of rings) {
      out.push(ring.length);
      for (const [x, y] of ring) out.push(x, y);
    }
  }
  return out;
}

function decodeLayout(d: Float64Array, start: number, pieces: Piece[]) {
  const length = d[start];
  const count = d[start + 1];
  const layout: Placement[] = [];
  let i = start + 2;
  for (let k = 0; k < count; k++, i += 4) {
    layout.push({ id: pieces[d[i]].id, rotation_deg: d[i + 1], tx: d[i + 2], ty: d[i + 3] });
  }
  return { length, layout, next: i };
}

const PHASES = ["seed", "anneal", "polish"] as const;

interface PendingCall {
  resolve: (d: Float64Array) => void;
  reject: (e: Error) => void;
  onFrame?: (d: Float64Array) => void;
}

export class BrowserEngine implements EngineClient {
  readonly kind = "browser" as const;
  readonly label = "In-browser WASM";
  readonly detail = "The same C++20 source compiled to WebAssembly, running in this tab";
  private worker: Worker | null = null;
  private counter = 0;
  private pending = new Map<number, PendingCall>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./wasmWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as { type: string; id?: number; data?: Float64Array; output?: Float64Array; message?: string };
      if (m.type === "frame") {
        for (const entry of this.pending.values()) entry.onFrame?.(m.data!);
        return;
      }
      const entry = this.pending.get(m.id!);
      if (!entry) return;
      this.pending.delete(m.id!);
      if (m.type === "done") entry.resolve(m.output!);
      else entry.reject(new Error(m.message));
    };
    worker.onerror = (event) => {
      for (const entry of this.pending.values()) entry.reject(new Error(event.message || "The engine worker crashed."));
      this.pending.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private call(op: "solve" | "baseline" | "radar", values: number[], onFrame?: (d: Float64Array) => void): Promise<Float64Array> {
    const worker = this.ensureWorker();
    const id = ++this.counter;
    const input = Float64Array.from(values);
    const url = new URL(`${import.meta.env.BASE_URL}cutzero_core.wasm`, location.href).href;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onFrame });
      worker.postMessage({ id, op, input, url }, [input.buffer]);
    });
  }

  async presets(): Promise<Preset[]> {
    const presets = await jsonOrThrow<Preset[]>(await fetch(`${import.meta.env.BASE_URL}presets.json`));
    for (const preset of presets) {
      const base = await this.baseline(jobFromPreset(preset));
      preset.baseline_length_mm = base.length;
      preset.baseline_layout = base.layout;
    }
    return presets;
  }

  async baseline(job: JobRequest): Promise<{ length: number; layout: Placement[] }> {
    const d = await this.call("baseline", encodeProblem(job, 0));
    const { length, layout } = decodeLayout(d, 1, job.pieces);
    return { length, layout };
  }

  run(job: JobRequest, { onFrame, onError }: RunCallbacks): RunHandle {
    let stopped = false;
    const area = job.pieces.reduce((t, p) => t + p.area_mm2, 0);
    const impactFor = (baseline: number, length: number) =>
      computeImpact(area, job.roll_width_mm, baseline, length, job.fabric_gsm, job.batch_count, job.co2_factor_kg_per_kg);

    const go = async () => {
      const base = await this.baseline(job);
      const d = await this.call("solve", encodeProblem(job, 60000), (frame) => {
        if (stopped) return;
        const { length, layout } = decodeLayout(frame, 9, job.pieces);
        onFrame({
          type: "progress",
          phase: PHASES[frame[0]],
          iteration: frame[1],
          max_iterations: frame[2],
          temperature: frame[3],
          elapsed_ms: frame[4],
          roll_width_mm: job.roll_width_mm,
          baseline_length_mm: base.length,
          optimized_length_mm: length,
          current_length_mm: frame[5],
          evaluations: frame[6],
          accepted_moves: frame[7],
          improved: frame[8] === 1,
          baseline_layout: base.layout,
          optimized_layout: layout,
          ...impactFor(base.length, length),
        });
      });
      if (stopped) return;
      const totalArea = d[0];
      const baseline = decodeLayout(d, 1, job.pieces);
      const optimized = decodeLayout(d, baseline.next, job.pieces);
      let i = optimized.next + 5; // Skip the baseline validation block.
      const engineValidation: EngineValidation = {
        valid: d[i] === 1,
        violations: d[i + 1],
        min_clearance_mm: d[i + 2],
        pairs_checked: d[i + 3],
        interlocks: d[i + 4],
      };
      i += 5;
      const stats: EngineStats = {
        evaluations: d[i],
        accepted_moves: d[i + 1],
        ffts: d[i + 2],
        placements: d[i + 3],
        avg_fft_ms: d[i + 4],
        avg_eval_ms: d[i + 5],
        solve_ms: d[i + 6],
        threads: d[i + 7],
        grid_rows: d[i + 8],
        grid_cols: d[i + 9],
        cell_mm: d[i + 10],
        frames: d[i + 11],
        cancelled: d[i + 12] === 1,
      };
      const rounded = optimized.layout.map((p) => ({ ...p, tx: +p.tx.toFixed(3), ty: +p.ty.toFixed(3) }));
      onFrame({
        type: "complete",
        job_id: null,
        iteration: job.max_iterations,
        max_iterations: job.max_iterations,
        elapsed_ms: stats.solve_ms,
        roll_width_mm: job.roll_width_mm,
        baseline_length_mm: baseline.length,
        optimized_length_mm: optimized.length,
        baseline_layout: baseline.layout,
        optimized_layout: rounded,
        engine_validation: engineValidation,
        verification: verifyLayout(job.pieces, rounded, job.roll_width_mm, job.kerf_mm),
        stats,
        cancelled: false,
        ...computeImpact(
          totalArea,
          job.roll_width_mm,
          baseline.length,
          optimized.length,
          job.fabric_gsm,
          job.batch_count,
          job.co2_factor_kg_per_kg,
        ),
      });
    };
    go().catch((error: Error) => {
      if (!stopped) onError(error.message);
    });

    return {
      stop: () => {
        // A worker cannot be interrupted mid-solve, so stopping discards it along with the run.
        stopped = true;
        this.worker?.terminate();
        this.worker = null;
        this.pending.clear();
      },
    };
  }

  async radar(job: JobRequest, layout: Placement[], pieceId: number, rotationDeg: number): Promise<RadarResult> {
    const indexOf = new Map(job.pieces.map((p, i) => [p.id, i]));
    const values = encodeProblem(job, 0);
    values.push(layout.length);
    for (const p of layout) values.push(indexOf.get(p.id)!, p.rotation_deg, p.tx, p.ty);
    values.push(indexOf.get(pieceId)!, rotationDeg);
    const d = await this.call("radar", values);
    const free = new Uint8Array(d.length - 7);
    for (let i = 7; i < d.length; i++) free[i - 7] = d[i];
    return { rows: d[0], cols: d[1], cell_mm: d[2], margin: d[3], fft_ms: d[4], piece_w: d[5], piece_h: d[6], free };
  }

  history(): Promise<JobHistory | null> {
    return Promise.resolve(null);
  }

  async parseSvg(file: File): Promise<{ name: string; pieces: Piece[] }> {
    const { parseSvgInBrowser } = await import("../lib/svgParse");
    return { name: file.name, pieces: parseSvgInBrowser(await file.text()) };
  }

  exportUrl(): null {
    return null;
  }
}

export function jobFromPreset(preset: Preset): JobRequest {
  return {
    name: preset.name,
    preset_id: preset.category === "custom" ? null : preset.id,
    pieces: preset.pieces,
    roll_width_mm: preset.roll_width_mm,
    kerf_mm: preset.default_kerf_mm,
    fabric_gsm: preset.fabric_gsm,
    batch_count: preset.default_batch_count,
    co2_factor_kg_per_kg: preset.co2_factor_kg_per_kg,
    allowed_rotations_deg: preset.default_rotations_deg,
    max_iterations: 200,
    seed: 42,
  };
}

/** Prefers the native server. Static hosting, or an unreachable server, falls back to WebAssembly. */
export async function detectEngine(): Promise<EngineClient> {
  if (new URLSearchParams(location.search).get("engine") === "wasm") return new BrowserEngine();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    const response = await fetch(`${API}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok && ((await response.json()) as { engine?: string }).engine === "native") return new ServerEngine();
  } catch {
    /* Fall through to the browser engine. */
  }
  return new BrowserEngine();
}
