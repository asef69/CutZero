import { useMemo, useState } from "react";
import type { ConvergencePoint } from "../hooks/useOptimizer";

const W = 320;
const H = 150;
const M = { top: 10, right: 10, bottom: 22, left: 42 };

/** Roll length against annealing iteration: one y-axis, best-so-far plus the live chain. */
export function ConvergenceChart({
  points,
  baselineLength,
  maxIterations,
}: {
  points: ConvergencePoint[];
  baselineLength: number;
  maxIterations: number;
}) {
  const [hover, setHover] = useState<ConvergencePoint | null>(null);

  const { x, y, yTicks } = useMemo(() => {
    const lengths = points.flatMap((p) => [p.best, p.current]);
    const lo = lengths.length ? Math.min(...lengths) : baselineLength * 0.75;
    const hi = lengths.length ? Math.max(...lengths, lo + 50) : baselineLength;
    const pad = (hi - lo) * 0.08;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const innerW = W - M.left - M.right;
    const innerH = H - M.top - M.bottom;
    const toX = (i: number) => M.left + (i / Math.max(maxIterations, 1)) * innerW;
    const toY = (v: number) => M.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;
    const step = (yMax - yMin) / 3;
    return { x: toX, y: toY, yTicks: [0, 1, 2, 3].map((k) => yMin + k * step) };
  }, [points, baselineLength, maxIterations]);

  const line = (key: "best" | "current") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.iteration).toFixed(1)} ${y(p[key]).toFixed(1)}`).join("");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = points[0];
    for (const p of points) {
      if (Math.abs(x(p.iteration) - px) < Math.abs(x(best.iteration) - px)) best = p;
    }
    setHover(best);
  };

  const last = points[points.length - 1];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="label">Roll length vs. iteration</h3>
        <div className="flex gap-3 text-[11px] text-ink-300">
          <span className="flex items-center gap-1">
            <i className="inline-block h-0.5 w-3 rounded bg-saved" /> best
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block h-0.5 w-3 rounded bg-ink-400" /> current
          </span>
        </div>
      </div>
      <div className="relative mt-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full"
          role="img"
          aria-label={last ? `Best roll length reached ${Math.round(last.best)} millimetres at iteration ${last.iteration}.` : "No search has run yet."}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="#1d2a37" strokeWidth={1} />
              <text x={M.left - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill="#71849a" fontFamily="JetBrains Mono, monospace">
                {Math.round(t).toLocaleString("en-US")}
              </text>
            </g>
          ))}
          <text x={M.left} y={H - 6} fontSize={9} fill="#71849a" fontFamily="JetBrains Mono, monospace">
            0
          </text>
          <text x={W - M.right} y={H - 6} textAnchor="end" fontSize={9} fill="#71849a" fontFamily="JetBrains Mono, monospace">
            {maxIterations.toLocaleString("en-US")} iterations
          </text>
          {points.length > 0 && (
            <>
              <path d={line("current")} fill="none" stroke="#71849a" strokeWidth={1} strokeLinejoin="round" />
              <path d={line("best")} fill="none" stroke="#2fd6a0" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(last.iteration)} cy={y(last.best)} r={4} fill="#2fd6a0" stroke="#0b1118" strokeWidth={2} />
            </>
          )}
          {hover && <line x1={x(hover.iteration)} x2={x(hover.iteration)} y1={M.top} y2={H - M.bottom} stroke="#4a5c6e" strokeWidth={1} />}
          {!points.length && (
            <text x={(M.left + W - M.right) / 2} y={H / 2} textAnchor="middle" fontSize={11} fill="#71849a">
              Convergence appears here during a run
            </text>
          )}
        </svg>
        {hover && (
          <div
            className="num pointer-events-none absolute top-1 rounded border border-ink-600 bg-ink-850/95 px-2 py-1 text-[11px] text-ink-200"
            style={{ left: `${Math.min(62, (x(hover.iteration) / W) * 100)}%` }}
          >
            <div>iter {hover.iteration.toLocaleString("en-US")}</div>
            <div>best {Math.round(hover.best).toLocaleString("en-US")} mm</div>
            <div>current {Math.round(hover.current).toLocaleString("en-US")} mm</div>
          </div>
        )}
      </div>
    </div>
  );
}
