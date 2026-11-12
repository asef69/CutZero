import { useEffect, useRef, useState } from "react";
import type { Impact } from "../types";

function useAnimated(target: number): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const diff = target - current.current;
      if (Math.abs(diff) < Math.abs(target) * 1e-4 + 1e-4) {
        current.current = target;
        setValue(target);
        return;
      }
      current.current += diff * (1 - Math.exp(-10 * dt));
      setValue(current.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}

function Card({
  label,
  value,
  unit,
  note,
  digits,
  empty,
  accent,
}: {
  label: string;
  value: number;
  unit: string;
  note: string;
  digits: number;
  empty: boolean;
  accent?: boolean;
}) {
  const shown = useAnimated(value);
  return (
    <div className="panel min-w-0 px-3.5 py-3">
      <div className="label truncate">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={`num text-[26px] font-semibold leading-8 ${empty ? "text-ink-500" : accent ? "text-saved" : "text-ink-100"}`}>
          {empty ? "–" : shown.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}
        </span>
        <span className="text-xs text-ink-300">{unit}</span>
      </div>
      <div className="num mt-0.5 truncate text-[11px] text-ink-400">{note}</div>
    </div>
  );
}

export function TelemetryBar({
  impact,
  baselineUtil,
  batch,
}: {
  impact: Impact | null;
  baselineUtil: number;
  batch: number;
}) {
  const empty = !impact;
  return (
    <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
      <Card
        label="Utilization"
        value={impact?.optimized_utilization_pct ?? 0}
        unit="%"
        digits={1}
        empty={empty}
        note={
          impact
            ? `${impact.baseline_utilization_pct.toFixed(1)}% → ${impact.optimized_utilization_pct.toFixed(1)}%  (+${impact.utilization_gain_pct.toFixed(1)} pts)`
            : `baseline ${baselineUtil.toFixed(1)}%`
        }
        accent
      />
      <Card
        label="Linear roll saved"
        value={impact?.linear_saved_m ?? 0}
        unit="m / lay"
        digits={3}
        empty={empty}
        note={impact ? `${impact.linear_saved_m_per_batch.toFixed(1)} m per ${batch.toLocaleString("en-US")} lays` : `per ${batch.toLocaleString("en-US")} lays`}
      />
      <Card
        label="Solid waste prevented"
        value={impact?.waste_saved_kg_per_batch ?? 0}
        unit="kg"
        digits={1}
        empty={empty}
        note={impact ? `${impact.area_saved_m2_per_batch.toFixed(1)} m² across the batch` : "landfill scrap avoided"}
      />
      <Card
        label="Carbon avoided"
        value={impact?.co2_saved_kg_per_batch ?? 0}
        unit="kg CO2e"
        digits={0}
        empty={empty}
        note="embodied carbon of unused material"
      />
    </div>
  );
}
