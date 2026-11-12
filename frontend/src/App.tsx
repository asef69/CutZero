import { useCallback, useEffect, useRef, useState } from "react";
import { ConvergenceChart } from "./components/ConvergenceChart";
import { ControlPanel } from "./components/ControlPanel";
import { CanvasMode, DualRollCanvas } from "./components/DualRollCanvas";
import { EngineCard, HistoryPanel, HowItWorks, ImpactPanel, MethodNote, VerificationCard } from "./components/InsightPanels";
import { TelemetryBar } from "./components/TelemetryBar";
import { useOptimizer } from "./hooks/useOptimizer";
import { downloadText, exportGcode, exportSvg } from "./lib/exports";
import type { RadarResult } from "./types";

function ToolButton({ active, disabled, onClick, children, title }: { active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "border-saved-dim bg-ink-800 text-ink-100" : "border-ink-700 text-ink-300 hover:border-ink-500 hover:text-ink-100"
      }`}
    >
      {children}
    </button>
  );
}

export default function App() {
  const o = useOptimizer();
  const [mode, setMode] = useState<CanvasMode>("view");
  const [fps, setFps] = useState(0);
  const [interlocks, setInterlocks] = useState(true);
  const [radar, setRadar] = useState<RadarResult | null>(null);
  const [radarPiece, setRadarPiece] = useState<{ id: number; name: string } | null>(null);
  const [radarBusy, setRadarBusy] = useState(false);
  const [radarError, setRadarError] = useState<string | null>(null);

  const { frame, complete, status, preset, settings, baseline, engine, job } = o;
  const running = status === "running";
  const done = status === "done" || status === "stopped";
  const layout = frame?.optimized_layout ?? null;
  const length = frame?.optimized_length_mm ?? null;

  // Leaving the finished state returns the canvas to its normal view.
  useEffect(() => {
    if (!done) {
      setMode("view");
      setRadar(null);
      setRadarPiece(null);
    }
  }, [done]);

  // Links like ?autorun=1 start immediately, which is handy for a judge's bookmark or a demo video.
  const autorun = useRef(new URLSearchParams(location.search).has("autorun"));
  useEffect(() => {
    if (autorun.current && engine && job && baseline) {
      autorun.current = false;
      o.run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, job, baseline]);

  const pick = useCallback(
    async (id: number, rotationDeg: number) => {
      if (mode !== "radar" || !engine || !job || !layout) return;
      const piece = job.pieces.find((p) => p.id === id);
      setRadarBusy(true);
      setRadarError(null);
      setRadarPiece(piece ? { id, name: piece.name } : null);
      try {
        setRadar(await engine.radar(job, layout, id, rotationDeg));
      } catch (e) {
        setRadarError((e as Error).message);
      } finally {
        setRadarBusy(false);
      }
    },
    [engine, job, layout, mode],
  );

  const toggleRadar = () => {
    if (mode === "radar") {
      setMode("view");
      setRadar(null);
      setRadarPiece(null);
      return;
    }
    setMode("radar");
    // Starts on the most compact part: it has the most pockets to go to, so the map is most telling.
    if (job && layout) {
      const span = (id: number) => {
        const piece = job.pieces.find((q) => q.id === id);
        if (!piece) return Infinity;
        const xs = piece.outer.map((q) => q[0]);
        const ys = piece.outer.map((q) => q[1]);
        return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      };
      const smallest = layout.reduce((best, p) => (span(p.id) < span(best.id) ? p : best), layout[0]);
      const piece = job.pieces.find((p) => p.id === smallest.id);
      setRadarBusy(true);
      setRadarError(null);
      setRadarPiece(piece ? { id: smallest.id, name: piece.name } : null);
      engine
        ?.radar(job, layout, smallest.id, smallest.rotation_deg)
        .then(setRadar)
        .catch((e: Error) => setRadarError(e.message))
        .finally(() => setRadarBusy(false));
    }
  };

  const download = (kind: "svg" | "gcode") => {
    if (!complete || !job) return;
    const url = complete.job_id ? engine?.exportUrl(complete.job_id, kind) : null;
    if (url) {
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      a.click();
      return;
    }
    const base = `cutzero-${job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (kind === "svg") {
      downloadText(
        `${base}.svg`,
        exportSvg(job.name, job.pieces, complete.optimized_layout, job.roll_width_mm, complete.optimized_length_mm, complete.optimized_utilization_pct, job.kerf_mm),
        "image/svg+xml",
      );
    } else {
      downloadText(
        `${base}.gcode`,
        exportGcode(job.name, job.pieces, complete.optimized_layout, job.roll_width_mm, complete.optimized_length_mm, job.kerf_mm),
        "text/plain",
      );
    }
  };

  if (!engine || !preset || !settings || !baseline) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6 text-center">
        {o.error ? (
          <div>
            <p className="text-sm font-medium text-ink-100">CutZero couldn't start</p>
            <p className="mt-1 text-sm text-ink-300">{o.error}</p>
          </div>
        ) : (
          <p className="text-sm text-ink-300">Loading the engine…</p>
        )}
      </main>
    );
  }

  const baselineUtil = (100 * preset.total_area_m2 * 1e6) / (settings.rollWidth * baseline.length);

  return (
    <div className="mx-auto max-w-[1680px] px-4 pb-10 pt-3 lg:px-5">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-ink-800 pb-3">
        <div className="flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-7 w-7" />
          <div>
            <h1 className="text-base font-semibold leading-tight tracking-tight text-ink-100">CutZero</h1>
            <p className="text-xs leading-tight text-ink-400">Nests curved parts into each other, so less fabric and metal ends up as scrap.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-300" title={engine.detail}>
          <span className="h-2 w-2 rounded-full bg-saved" />
          {engine.label}
        </div>
      </header>

      {o.error && (
        <div role="alert" className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-waste-dim bg-ink-850 px-3 py-2 text-sm text-ink-100">
          {o.error}
          <button type="button" className="text-xs text-ink-300 underline" onClick={o.clearError}>
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-[250px_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)_290px]">
        <div className="panel p-3">
          <ControlPanel
            presets={o.presets}
            selectedId={preset.id}
            settings={settings}
            status={status}
            onSelect={o.selectPreset}
            onChange={o.setSettings}
            onRun={o.run}
            onStop={o.stop}
            onUpload={o.addCustom}
          />
        </div>

        <main className="flex min-w-0 flex-col gap-3">
          <TelemetryBar impact={frame} baselineUtil={baselineUtil} batch={settings.batch} />

          <div className="panel p-2">
            <DualRollCanvas
              pieces={preset.pieces}
              rollWidth={settings.rollWidth}
              baselineLayout={baseline.layout}
              baselineLength={baseline.length}
              optimizedLayout={layout}
              optimizedLength={length}
              running={running}
              done={done}
              mode={mode}
              showInterlocks={interlocks}
              radar={radar}
              radarPieceId={radarPiece?.id ?? null}
              onPickPiece={pick}
              onToolpathEnd={() => setMode("view")}
              onFps={setFps}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-2 pb-1 pt-2">
              <ToolButton disabled={!complete} active={mode === "toolpath"} onClick={() => setMode(mode === "toolpath" ? "view" : "toolpath")} title="Animate the CNC cutting order on the nested layout">
                {mode === "toolpath" ? "Stop toolpath" : "Preview CNC toolpath"}
              </ToolButton>
              <ToolButton disabled={!done} active={mode === "radar"} onClick={toggleRadar} title="Show every free position for a part, from one real FFT correlation">
                FFT radar
              </ToolButton>
              <ToolButton disabled={!done} active={interlocks} onClick={() => setInterlocks((v) => !v)} title="Highlight where bounding boxes overlap while the parts themselves stay clear">
                Interlocks
              </ToolButton>
              <span className="min-w-2 flex-1" />
              <ToolButton disabled={!complete} onClick={() => download("svg")}>
                Download nested SVG
              </ToolButton>
              <ToolButton disabled={!complete} onClick={() => download("gcode")}>
                Export CNC G-code
              </ToolButton>
            </div>
            {mode === "radar" && (
              <p className="px-2 pb-1 pt-2 text-xs text-ink-300">
                {radarError ? (
                  <span className="text-waste">{radarError}</span>
                ) : radarBusy || !radar ? (
                  "Scanning…"
                ) : (
                  <>
                    Green marks every spot inside the nest where <span className="font-medium text-ink-100">{radarPiece?.name}</span> fits, counting the spot it sits in now. One FFT
                    cross-correlation tested all <span className="num text-ink-100">{(radar.rows * radar.cols).toLocaleString("en-US")}</span> grid positions in{" "}
                    <span className="num text-ink-100">{radar.fft_ms.toFixed(1)} ms</span>. Hover to preview a spot; click another part to scan it.
                  </>
                )}
              </p>
            )}
            {mode === "view" && complete && interlocks && complete.engine_validation.interlocks > 0 && (
              <p className="px-2 pb-1 pt-2 text-xs text-ink-300">
                <span className="mr-1.5 inline-block h-2.5 w-2.5 translate-y-px rounded-sm border border-signal bg-signal/40" />
                Amber marks where bounding boxes overlap, which is impossible for a box packer. {complete.engine_validation.interlocks} pairs of parts nest this way.
              </p>
            )}
          </div>
        </main>

        <div className="panel flex flex-col gap-4 p-3 lg:col-span-2 lg:grid lg:grid-cols-3 2xl:col-span-1 2xl:flex">
          <ConvergenceChart points={o.convergence} baselineLength={baseline.length} maxIterations={settings.iterations} />
          <VerificationCard complete={complete} />
          <EngineCard frame={frame} complete={complete} engine={engine} fps={fps} />
        </div>
      </div>

      <div className="mt-3 panel p-4">
        <ImpactPanel key={preset.category} impact={frame} gsm={settings.gsm} co2Factor={preset.co2_factor_kg_per_kg} isMetal={preset.category === "metal"} />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_1.2fr]">
        <div className="panel p-4">
          <h2 className="label mb-3">How it works</h2>
          <HowItWorks />
          <div className="mt-4 border-t border-ink-800 pt-3">
            <MethodNote />
          </div>
        </div>
        <div className="panel p-4">
          <h2 className="label mb-3">Run history</h2>
          <HistoryPanel history={o.history} exportUrl={(id, kind) => engine.exportUrl(id, kind)} />
        </div>
      </div>
    </div>
  );
}
