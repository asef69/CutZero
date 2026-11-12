import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserEngine, EngineClient, RunHandle, detectEngine, jobFromPreset } from "../engine/client";
import type { CompleteFrame, JobHistory, JobRequest, Placement, Preset, ProgressFrame } from "../types";

export interface ConvergencePoint {
  iteration: number;
  best: number;
  current: number;
}

export type RunStatus = "idle" | "running" | "done" | "stopped";

export interface Settings {
  rollWidth: number;
  kerf: number;
  gsm: number;
  batch: number;
  rotations: number[];
  iterations: number;
}

function settingsFrom(preset: Preset): Settings {
  return {
    rollWidth: preset.roll_width_mm,
    kerf: preset.default_kerf_mm,
    gsm: preset.fabric_gsm,
    batch: preset.default_batch_count,
    rotations: preset.default_rotations_deg,
    iterations: 200,
  };
}

export function useOptimizer() {
  const [engine, setEngine] = useState<EngineClient | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [baseline, setBaseline] = useState<{ length: number; layout: Placement[] } | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [frame, setFrame] = useState<ProgressFrame | CompleteFrame | null>(null);
  const [complete, setComplete] = useState<CompleteFrame | null>(null);
  const [convergence, setConvergence] = useState<ConvergencePoint[]>([]);
  const [history, setHistory] = useState<JobHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const handleRef = useRef<RunHandle | null>(null);

  const preset = useMemo(() => presets.find((p) => p.id === selectedId) ?? null, [presets, selectedId]);

  const clearRun = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setStatus("idle");
    setFrame(null);
    setComplete(null);
    setConvergence([]);
  }, []);

  const refreshHistory = useCallback(async (client: EngineClient) => {
    try {
      setHistory(await client.history());
    } catch {
      setHistory(null);
    }
  }, []);

  const adopt = useCallback(
    async (client: EngineClient) => {
      setLoading(true);
      setError(null);
      try {
        const list = await client.presets();
        setEngine(client);
        setPresets(list);
        const first = list[0];
        setSelectedId(first.id);
        setSettings(settingsFrom(first));
        setBaseline({ length: first.baseline_length_mm!, layout: first.baseline_layout! });
        clearRun();
        void refreshHistory(client);
      } finally {
        setLoading(false);
      }
    },
    [clearRun, refreshHistory],
  );

  useEffect(() => {
    let alive = true;
    detectEngine()
      .then(async (client) => {
        if (!alive) return;
        try {
          await adopt(client);
        } catch (e) {
          if (client.kind === "server") {
            // A server that answers health checks but fails on presets should not block the demo.
            await adopt(new BrowserEngine());
          } else {
            throw e;
          }
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      handleRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectPreset = useCallback(
    (id: string) => {
      const next = presets.find((p) => p.id === id);
      if (!next) return;
      clearRun();
      setError(null);
      setSelectedId(id);
      setSettings(settingsFrom(next));
      setBaseline({ length: next.baseline_length_mm!, layout: next.baseline_layout! });
    },
    [clearRun, presets],
  );

  const job = useMemo<JobRequest | null>(() => {
    if (!preset || !settings) return null;
    return {
      ...jobFromPreset(preset),
      roll_width_mm: settings.rollWidth,
      kerf_mm: settings.kerf,
      fabric_gsm: settings.gsm,
      batch_count: settings.batch,
      allowed_rotations_deg: settings.rotations,
      max_iterations: settings.iterations,
    };
  }, [preset, settings]);

  // Geometry settings change the baseline itself, so it is recomputed before the next run.
  const geometryKey = settings ? `${settings.rollWidth}|${settings.kerf}|${settings.rotations.join(",")}` : "";
  const lastKey = useRef("");
  useEffect(() => {
    if (!engine || !job || !preset) return;
    const key = `${preset.id}|${geometryKey}`;
    if (lastKey.current === key) return;
    const isDefault =
      settings?.rollWidth === preset.roll_width_mm &&
      settings?.kerf === preset.default_kerf_mm &&
      settings?.rotations.join() === preset.default_rotations_deg.join();
    lastKey.current = key;
    if (isDefault && preset.baseline_layout) {
      setBaseline({ length: preset.baseline_length_mm!, layout: preset.baseline_layout });
      return;
    }
    const timer = setTimeout(() => {
      engine
        .baseline(job)
        .then((b) => {
          setBaseline(b);
          setError(null);
          clearRun();
        })
        .catch((e: Error) => setError(e.message));
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometryKey, engine, preset]);

  const run = useCallback(() => {
    if (!engine || !job) return;
    handleRef.current?.stop();
    setError(null);
    setStatus("running");
    setFrame(null);
    setComplete(null);
    setConvergence([]);
    handleRef.current = engine.run(job, {
      onFrame: (f) => {
        setFrame(f);
        if (f.type === "progress") {
          setBaseline((b) => (b && b.length === f.baseline_length_mm ? b : { length: f.baseline_length_mm, layout: f.baseline_layout }));
          setConvergence((c) => [
            ...c,
            { iteration: f.iteration, best: f.optimized_length_mm, current: f.current_length_mm },
          ]);
        } else {
          setComplete(f);
          setStatus(f.cancelled ? "stopped" : "done");
          void refreshHistory(engine);
        }
      },
      onError: (message) => {
        setError(message);
        setStatus("idle");
      },
    });
  }, [engine, job, refreshHistory]);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    // The browser engine is torn down outright, so no final frame will arrive for it.
    if (engine?.kind === "browser") {
      setStatus(frame ? "stopped" : "idle");
    }
  }, [engine, frame]);

  const addCustom = useCallback(
    async (file: File) => {
      if (!engine || !settings) return;
      setError(null);
      try {
        const { name, pieces } = await engine.parseSvg(file);
        const custom: Preset = {
          id: `custom_${Date.now()}`,
          name: name.replace(/\.svg$/i, ""),
          description: "Uploaded SVG pattern.",
          category: "custom",
          material: "Custom material",
          roll_width_mm: settings.rollWidth,
          fabric_gsm: settings.gsm,
          co2_factor_kg_per_kg: settings.gsm >= 1000 ? 11.5 : 15.2,
          default_rotations_deg: [0, 90, 180, 270],
          default_kerf_mm: settings.kerf,
          default_batch_count: settings.batch,
          piece_count: pieces.length,
          total_area_m2: pieces.reduce((t, p) => t + p.area_mm2, 0) / 1e6,
          pieces,
        };
        const tall = Math.max(
          ...pieces.map((p) => {
            const ys = p.outer.map((q) => q[1]);
            const xs = p.outer.map((q) => q[0]);
            return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
          }),
        );
        // A roll narrower than the widest part could never hold it; open it up rather than fail.
        custom.roll_width_mm = Math.max(settings.rollWidth, Math.ceil(tall + 2 * settings.kerf + 10));
        const base = await engine.baseline(jobFromPreset(custom));
        custom.baseline_length_mm = base.length;
        custom.baseline_layout = base.layout;
        clearRun();
        lastKey.current = "";
        setPresets((list) => [...list, custom]);
        setSelectedId(custom.id);
        setSettings(settingsFrom(custom));
        setBaseline(base);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [clearRun, engine, settings],
  );

  return {
    engine,
    presets,
    preset,
    settings,
    setSettings,
    baseline,
    status,
    frame,
    complete,
    convergence,
    history,
    error,
    loading,
    job,
    selectPreset,
    run,
    stop,
    addCustom,
    clearError: () => setError(null),
  };
}
