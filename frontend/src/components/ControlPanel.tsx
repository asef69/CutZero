import { useRef, useState } from "react";
import type { RunStatus, Settings } from "../hooks/useOptimizer";
import type { Preset } from "../types";

interface Props {
  presets: Preset[];
  selectedId: string | null;
  settings: Settings;
  status: RunStatus;
  onSelect(id: string): void;
  onChange(next: Settings): void;
  onRun(): void;
  onStop(): void;
  onUpload(file: File): void;
}

const ROTATIONS: { key: string; label: string; hint: string; angles: number[] }[] = [
  { key: "grain", label: "0/180°", hint: "Grainline locked", angles: [0, 180] },
  { key: "quarter", label: "90° steps", hint: "Free quarter turns", angles: [0, 90, 180, 270] },
  { key: "fine", label: "15° steps", hint: "Any 15° angle", angles: Array.from({ length: 24 }, (_, i) => i * 15) },
];

const DEPTHS = [
  { value: 200, label: "Demo", hint: "200 iterations" },
  { value: 1000, label: "Deep", hint: "1,000 iterations" },
  { value: 5000, label: "Max", hint: "5,000 iterations" },
];

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title: string }[];
  onChange(v: T): void;
}) {
  return (
    <fieldset>
      <legend className="label mb-1.5">{label}</legend>
      <div className="grid gap-1 rounded-lg bg-ink-850 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            title={o.title}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-1 py-1.5 text-xs font-medium transition-colors ${
              o.value === value ? "bg-ink-600 text-ink-100" : "text-ink-300 hover:text-ink-100"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function NumberField({
  label,
  unit,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit(v: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) onCommit(parsed);
    setDraft(null);
  };
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="mt-1 flex items-baseline rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 focus-within:border-saved-dim">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={draft ?? value}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="num w-full min-w-0 bg-transparent text-sm text-ink-100 outline-none"
        />
        <span className="ml-1 text-[11px] text-ink-400">{unit}</span>
      </span>
    </label>
  );
}

export function ControlPanel(props: Props) {
  const { settings, status } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const running = status === "running";
  const rotationKey = ROTATIONS.find((r) => r.angles.join() === settings.rotations.join())?.key ?? "quarter";

  const sample = async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}samples/laser_brackets.svg`);
    props.onUpload(new File([await response.blob()], "laser_brackets.svg", { type: "image/svg+xml" }));
  };

  return (
    <aside className="flex flex-col gap-4">
      <button
        type="button"
        onClick={running ? props.onStop : props.onRun}
        className={`w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
          running ? "bg-ink-700 text-ink-100 hover:bg-ink-600" : "bg-saved text-ink-950 hover:brightness-110"
        }`}
      >
        {running ? "Stop search" : status === "done" || status === "stopped" ? "Run again" : "Run C++ FFT + SA optimizer"}
      </button>

      <section>
        <h2 className="label mb-1.5">Workload</h2>
        <ul className="flex flex-col gap-1.5">
          {props.presets.map((p) => {
            const active = p.id === props.selectedId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => props.onSelect(p.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    active ? "border-saved-dim bg-ink-850" : "border-ink-700 hover:border-ink-500"
                  }`}
                >
                  <span className="block text-sm font-medium text-ink-100">{p.name}</span>
                  <span className="num mt-0.5 block text-[11px] text-ink-400">
                    {p.piece_count} pieces · {Math.round(p.roll_width_mm)} mm · {p.material}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) props.onUpload(file);
          }}
          className={`mt-2 rounded-lg border border-dashed px-3 py-2.5 text-center text-xs text-ink-300 transition-colors ${
            dragging ? "border-saved bg-ink-850" : "border-ink-600"
          }`}
        >
          Drop an SVG pattern, or{" "}
          <button type="button" className="font-medium text-ink-100 underline underline-offset-2" onClick={() => fileRef.current?.click()}>
            browse
          </button>{" "}
          ·{" "}
          <button type="button" className="font-medium text-ink-100 underline underline-offset-2" onClick={sample}>
            try a sample
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) props.onUpload(file);
              e.target.value = "";
            }}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <Segmented
          label="Allowed rotation"
          value={rotationKey}
          options={ROTATIONS.map((r) => ({ value: r.key, label: r.label, title: r.hint }))}
          onChange={(key) => props.onChange({ ...settings, rotations: ROTATIONS.find((r) => r.key === key)!.angles })}
        />
        <Segmented
          label="Search depth"
          value={settings.iterations}
          options={DEPTHS.map((d) => ({ value: d.value, label: d.label, title: d.hint }))}
          onChange={(iterations) => props.onChange({ ...settings, iterations })}
        />
      </section>

      <section className="grid grid-cols-2 gap-2.5">
        <NumberField label="Roll width" unit="mm" value={settings.rollWidth} min={50} max={10000} step={10} onCommit={(rollWidth) => props.onChange({ ...settings, rollWidth })} />
        <NumberField label="Kerf" unit="mm" value={settings.kerf} min={0} max={50} step={0.5} onCommit={(kerf) => props.onChange({ ...settings, kerf })} />
        <NumberField label="Material" unit="g/m²" value={settings.gsm} min={1} max={100000} step={10} onCommit={(gsm) => props.onChange({ ...settings, gsm })} />
        <NumberField label="Batch" unit="lays" value={settings.batch} min={1} max={1000000} step={10} onCommit={(batch) => props.onChange({ ...settings, batch })} />
      </section>
    </aside>
  );
}
