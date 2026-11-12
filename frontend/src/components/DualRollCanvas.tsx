import { useEffect, useMemo, useRef, useState } from "react";
import { cutOrder } from "../lib/exports";
import { familyColors, pointInPiece, ringCentroid } from "../lib/geometry";
import type { Defect, Piece, Placement, Pt, RadarResult } from "../types";

export type CanvasMode = "view" | "toolpath" | "radar" | "defects";

interface Props {
  pieces: Piece[];
  rollWidth: number;
  baselineLayout: Placement[];
  baselineLength: number;
  optimizedLayout: Placement[] | null;
  optimizedLength: number | null;
  running: boolean;
  done: boolean;
  mode: CanvasMode;
  showInterlocks: boolean;
  radar: RadarResult | null;
  radarPieceId: number | null;
  /** Fabric flaws, drawn on both rolls. */
  defects: Defect[];
  /** In "defects" mode, a click on either roll adds a flaw there or removes the one under it. */
  onEditDefect(x: number, y: number): void;
  onPickPiece(id: number, rotationDeg: number): void;
  onToolpathEnd(): void;
  onFps(fps: number): void;
}

interface Sprite {
  piece: Piece;
  color: string;
  path: Path2D;
  /** Centroid in the piece's own coordinates. */
  c: Pt;
  /** Half-diagonal, for quick hit rejection. */
  radius: number;
}

interface Pose {
  x: number;
  y: number;
  a: number;
}

const CHROME = { left: 46, right: 18, top: 30, gap: 34, bottom: 24 };
const RATE = 9; // Tween speed, per second.

function poseOf(sprite: Sprite, p: Placement): Pose {
  const r = (p.rotation_deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: c * sprite.c[0] - s * sprite.c[1] + p.tx, y: s * sprite.c[0] + c * sprite.c[1] + p.ty, a: r };
}

function boundsOf(sprite: Sprite, p: Placement) {
  const r = (p.rotation_deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of sprite.piece.outer) {
    const wx = c * x - s * y + p.tx;
    const wy = s * x + c * y + p.ty;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }
  return { minX, minY, maxX, maxY };
}

function fmt(mm: number): string {
  return `${Math.round(mm).toLocaleString("en-US")} mm`;
}

export function DualRollCanvas(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  const sprites = useMemo(() => {
    const map = new Map<number, Sprite>();
    const colors = familyColors(props.pieces.map((p) => p.name));
    for (const [index, piece] of props.pieces.entries()) {
      const path = new Path2D();
      const c = ringCentroid(piece.outer);
      let radius = 0;
      for (const ring of [piece.outer, ...piece.holes]) {
        ring.forEach(([x, y], i) => {
          const px = x - c[0];
          const py = y - c[1];
          radius = Math.max(radius, Math.hypot(px, py));
          if (i === 0) path.moveTo(px, py);
          else path.lineTo(px, py);
        });
        path.closePath();
      }
      map.set(piece.id, { piece, color: colors[index], path, c, radius });
    }
    return map;
  }, [props.pieces]);

  // Everything the render loop reads lives in a ref, so frames arriving at 20+ per second
  // never trigger a React render of the canvas itself.
  const live = useRef({
    props,
    sprites,
    poses: new Map<number, Pose>(),
    cutLine: 0,
    view: { zoom: 1, panX: 0 },
    size: { w: 0, h: 0, dpr: 1 },
    scale: 0.2,
    hoverId: null as number | null,
    pointer: null as Pt | null,
    dirty: true,
    toolpath: null as null | { contours: { ring: Pt[]; length: number }[]; total: number; started: number },
    hatch: null as CanvasPattern | null,
  });
  live.current.props = props;
  live.current.sprites = sprites;
  live.current.dirty = true;

  // Any new layout: bottom-roll sprites glide from wherever they are now.
  useEffect(() => {
    const state = live.current;
    const source = props.optimizedLayout ?? props.baselineLayout;
    const next = new Map<number, Pose>();
    for (const p of source) {
      const sprite = sprites.get(p.id);
      if (!sprite) continue;
      next.set(p.id, state.poses.get(p.id) ?? poseOf(sprite, p));
    }
    state.poses = next;
    state.dirty = true;
  }, [sprites, props.optimizedLayout, props.baselineLayout]);

  useEffect(() => {
    live.current.view = { zoom: 1, panX: 0 };
    live.current.cutLine = 0;
    live.current.poses = new Map();
    live.current.dirty = true;
  }, [props.pieces, props.rollWidth]);

  useEffect(() => {
    const state = live.current;
    if (props.mode === "toolpath" && props.optimizedLayout) {
      const contours = cutOrder(props.pieces, props.optimizedLayout).map(({ ring }) => {
        let length = 0;
        ring.forEach((pt, i) => {
          const q = ring[(i + 1) % ring.length];
          length += Math.hypot(q[0] - pt[0], q[1] - pt[1]);
        });
        return { ring, length };
      });
      state.toolpath = { contours, total: contours.reduce((t, c) => t + c.length, 0), started: performance.now() };
    } else {
      state.toolpath = null;
    }
    state.dirty = true;
  }, [props.mode, props.optimizedLayout, props.pieces]);

  // Resize: the canvas fills its column and picks a height the rolls fit into without scrolling.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const measure = () => {
      const state = live.current;
      const { rollWidth, baselineLength } = state.props;
      const w = wrap.clientWidth;
      const fitWidth = (w - CHROME.left - CHROME.right) / (baselineLength * 1.02);
      const maxH = Math.max(380, Math.min(window.innerHeight - 250, 860));
      const chrome = CHROME.top * 2 + CHROME.gap + CHROME.bottom;
      const scale = Math.min(fitWidth, (maxH - chrome) / (2 * rollWidth));
      const h = Math.round(chrome + 2 * rollWidth * scale);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      state.size = { w, h, dpr };
      state.scale = scale;
      state.hatch = null;
      state.dirty = true;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [props.rollWidth, props.baselineLength]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsStart = last;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const state = live.current;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      const moved = stepPoses(state, reduced ? 1 : 1 - Math.exp(-RATE * dt));
      if (!moved && !state.dirty && !state.toolpath) {
        fpsStart = now;
        frames = 0;
        return;
      }
      state.dirty = false;
      draw(ctx, state, now);

      frames += 1;
      if (now - fpsStart > 500) {
        state.props.onFps(Math.round((frames * 1000) / (now - fpsStart)));
        fpsStart = now;
        frames = 0;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pointer interaction.
  const worldAt = (clientX: number, clientY: number) => {
    const state = live.current;
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const s = state.scale * state.view.zoom;
    const rollH = state.props.rollWidth * state.scale;
    const topY = CHROME.top;
    const bottomY = CHROME.top + rollH + CHROME.gap + CHROME.top;
    const x = (sx - CHROME.left - state.view.panX) / s;
    if (sy >= bottomY && sy <= bottomY + rollH) return { strip: "bottom" as const, x, y: (sy - bottomY) / state.scale, sx, sy, scale: s };
    if (sy >= topY && sy <= topY + rollH) return { strip: "top" as const, x, y: (sy - topY) / state.scale, sx, sy, scale: s };
    return { strip: null, x, y: 0, sx, sy, scale: s };
  };

  const pieceAt = (strip: "top" | "bottom", x: number, y: number): { piece: Piece; place: Placement } | null => {
    const layout = strip === "top" ? props.baselineLayout : props.optimizedLayout ?? props.baselineLayout;
    for (const place of layout) {
      const sprite = sprites.get(place.id);
      if (!sprite) continue;
      const pose = poseOf(sprite, place);
      if (Math.hypot(x - pose.x, y - pose.y) > sprite.radius) continue;
      // Undo the placement to test against the original rings.
      const r = (-place.rotation_deg * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      const dx = x - place.tx;
      const dy = y - place.ty;
      if (pointInPiece([c * dx - s * dy, s * dx + c * dy], sprite.piece.outer, sprite.piece.holes)) {
        return { piece: sprite.piece, place };
      }
    }
    return null;
  };

  const drag = useRef<{ x: number; pan: number; moved: boolean } | null>(null);

  const onPointerMove = (e: React.PointerEvent) => {
    const state = live.current;
    if (drag.current) {
      const dx = e.clientX - drag.current.x;
      if (Math.abs(dx) > 3) drag.current.moved = true;
      state.view.panX = clampPan(state, drag.current.pan + dx);
      state.dirty = true;
      return;
    }
    const at = worldAt(e.clientX, e.clientY);
    state.pointer = at.strip === "bottom" ? [at.x, at.y] : null;
    state.dirty = true;
    if (!at.strip) {
      state.hoverId = null;
      setTooltip(null);
      return;
    }
    const hit = pieceAt(at.strip, at.x, at.y);
    state.hoverId = hit && at.strip === "bottom" ? hit.piece.id : null;
    const flaw = props.defects.find((d) => Math.hypot(d.x - at.x, d.y - at.y) <= d.r + 6);
    if (flaw) {
      setTooltip({
        x: at.sx,
        y: at.sy,
        title: "Fabric flaw",
        lines: [`${flaw.r * 2} mm across at ${Math.round(flaw.x)}, ${Math.round(flaw.y)} mm`, props.mode === "defects" ? "click to remove" : "no part may touch it"],
      });
    } else if (props.mode === "defects") {
      setTooltip(null);
    } else if (hit && props.mode !== "radar") {
      setTooltip({
        x: at.sx,
        y: at.sy,
        title: hit.piece.name,
        lines: [`${(hit.piece.area_mm2 / 1e6).toFixed(3)} m² of material`, `rotated ${hit.place.rotation_deg}°`],
      });
    } else {
      setTooltip(null);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, pan: live.current.view.panX, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasDrag = drag.current?.moved;
    drag.current = null;
    if (wasDrag) return;
    if (props.mode === "defects") {
      const at = worldAt(e.clientX, e.clientY);
      if (at.strip) props.onEditDefect(at.x, at.y);
      return;
    }
    if (!props.done) return;
    const at = worldAt(e.clientX, e.clientY);
    if (at.strip !== "bottom") return;
    const hit = pieceAt("bottom", at.x, at.y);
    if (hit) props.onPickPiece(hit.piece.id, hit.place.rotation_deg);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      const state = live.current;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left - CHROME.left;
      const old = state.view.zoom;
      const next = Math.min(6, Math.max(1, old * Math.exp(-e.deltaY * 0.0015)));
      state.view.panX = clampPan(state, sx - ((sx - state.view.panX) * next) / old, next);
      state.view.zoom = next;
      state.dirty = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const clampPan = (state: typeof live.current, pan: number, zoom = state.view.zoom) => {
    const width = state.props.baselineLength * state.scale * zoom;
    const visible = state.size.w - CHROME.left - CHROME.right;
    return Math.min(0, Math.max(Math.min(0, visible - width), pan));
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={
          props.optimizedLength
            ? `Two fabric rolls drawn to scale. The bounding-box baseline uses ${fmt(props.baselineLength)}; the nested layout uses ${fmt(props.optimizedLength)}.`
            : `A fabric roll with the bounding-box baseline layout, ${fmt(props.baselineLength)} long.`
        }
        className="block w-full touch-none select-none"
        style={{ cursor: props.mode === "radar" || props.mode === "defects" ? "crosshair" : "default" }}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          live.current.pointer = null;
          live.current.hoverId = null;
          live.current.dirty = true;
          setTooltip(null);
        }}
        onDoubleClick={() => {
          live.current.view = { zoom: 1, panX: 0 };
          live.current.dirty = true;
        }}
      />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-ink-600 bg-ink-850/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(tooltip.x + 14, (wrapRef.current?.clientWidth ?? 600) - 190),
            top: tooltip.y + 14,
          }}
        >
          <div className="font-semibold text-ink-100">{tooltip.title}</div>
          {tooltip.lines.map((line) => (
            <div key={line} className="num text-[11px] text-ink-300">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /** Advances every pose and the cut-line; returns whether anything is still moving. */
  function stepPoses(state: typeof live.current, k: number): boolean {
    const { props: p, sprites: map } = state;
    const layout = p.optimizedLayout ?? p.baselineLayout;
    let moving = false;
    for (const place of layout) {
      const sprite = map.get(place.id);
      if (!sprite) continue;
      const target = poseOf(sprite, place);
      let pose = state.poses.get(place.id);
      if (!pose) {
        pose = { ...target };
        state.poses.set(place.id, pose);
      }
      const dx = target.x - pose.x;
      const dy = target.y - pose.y;
      // Shortest way round, so a 270° gene never spins three-quarters of a turn the long way.
      let da = (target.a - pose.a) % (2 * Math.PI);
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      if (Math.abs(dx) + Math.abs(dy) < 0.05 && Math.abs(da) < 1e-3) {
        pose.x = target.x;
        pose.y = target.y;
        pose.a = target.a;
        continue;
      }
      moving = true;
      pose.x += dx * k;
      pose.y += dy * k;
      pose.a += da * k;
    }
    const cutTarget = p.optimizedLength ?? p.baselineLength;
    if (state.cutLine === 0) state.cutLine = cutTarget;
    const dc = cutTarget - state.cutLine;
    if (Math.abs(dc) > 0.2) {
      state.cutLine += dc * k;
      moving = true;
    } else {
      state.cutLine = cutTarget;
    }
    return moving;
  }
}

function hatchPattern(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern | null {
  const size = Math.round(10 * dpr);
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const t = tile.getContext("2d")!;
  t.strokeStyle = "rgba(47,214,160,0.55)";
  t.lineWidth = 1.4 * dpr;
  t.beginPath();
  t.moveTo(-1, size + 1);
  t.lineTo(size + 1, -1);
  t.stroke();
  return ctx.createPattern(tile, "repeat");
}

type LiveState = {
  props: Props;
  sprites: Map<number, Sprite>;
  poses: Map<number, Pose>;
  cutLine: number;
  view: { zoom: number; panX: number };
  size: { w: number; h: number; dpr: number };
  scale: number;
  hoverId: number | null;
  pointer: Pt | null;
  toolpath: null | { contours: { ring: Pt[]; length: number }[]; total: number; started: number };
  hatch: CanvasPattern | null;
};

function draw(ctx: CanvasRenderingContext2D, state: LiveState, now: number) {
  const { props: p, size, scale, view, sprites } = state;
  const { w, h, dpr } = size;
  if (!w) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const rollH = p.rollWidth * scale;
  const s = scale * view.zoom;
  const left = CHROME.left;
  const stripW = w - CHROME.left - CHROME.right;
  const topY = CHROME.top;
  const bottomY = topY + rollH + CHROME.gap + CHROME.top;
  const baseLen = p.baselineLength;
  const X = (mm: number) => left + view.panX + mm * s;

  const header = (y: number, color: string, title: string, right: string) => {
    ctx.font = "600 12px 'Inter Variable', sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = color;
    ctx.fillRect(left, y - 17, 3, 12);
    ctx.fillStyle = "#e6ecf2";
    ctx.fillText(title, left + 9, y - 7);
    ctx.font = "400 11px 'JetBrains Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "#9aabbc";
    ctx.fillText(right, left + stripW, y - 7);
    ctx.textAlign = "left";
  };

  const rollBackground = (y: number) => {
    ctx.fillStyle = "#0f1720";
    ctx.fillRect(left, y, stripW, rollH);
    // Width scale on the left edge.
    ctx.strokeStyle = "#2b3a4a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left - 8.5, y + 0.5);
    ctx.lineTo(left - 8.5, y + rollH - 0.5);
    ctx.moveTo(left - 13, y + 0.5);
    ctx.lineTo(left - 4, y + 0.5);
    ctx.moveTo(left - 13, y + rollH - 0.5);
    ctx.lineTo(left - 4, y + rollH - 0.5);
    ctx.stroke();
    ctx.save();
    ctx.translate(left - 17, y + rollH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = "400 10px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#71849a";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(p.rollWidth)} mm`, 0, 0);
    ctx.restore();
  };

  const ruler = (y: number) => {
    // Ticks at least ~55 px apart, so labels never collide on a long roll.
    const major = [500, 1000, 2000, 5000, 10000].find((step) => step * s >= 55) ?? 20000;
    ctx.font = "400 10px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const maxMm = Math.max(baseLen * 1.05, (left + stripW - X(0)) / s);
    for (let mm = 0; mm <= maxMm; mm += major) {
      const x = X(mm);
      if (x < left - 1 || x > left + stripW + 1) continue;
      ctx.fillStyle = "#2b3a4a";
      ctx.fillRect(Math.round(x), y, 1, 5);
      ctx.fillStyle = "#71849a";
      ctx.fillText(mm === 0 ? "0" : `${mm / 1000} m`, Math.round(x), y + 7);
    }
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  };

  const trace = (pose: Pose, fn: () => void) => {
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.a);
    fn();
    ctx.restore();
  };

  const inRoll = (y: number, body: () => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, y, stripW, rollH);
    ctx.clip();
    ctx.translate(left + view.panX, y);
    ctx.scale(s, scale);
    body();
    ctx.restore();
  };

  const cutMarker = (x: number, y: number, color: string, glow: boolean) => {
    ctx.save();
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + rollH + 4);
    ctx.stroke();
    ctx.restore();
  };

  // ---------------- Top roll: bounding-box baseline ----------------
  const baseUtil = (100 * p.pieces.reduce((t, c) => t + c.area_mm2, 0)) / (p.rollWidth * baseLen);
  header(topY, "#f0506e", "Industry baseline: first-fit bounding boxes", `${Math.round(baseLen).toLocaleString("en-US")} mm · η ${baseUtil.toFixed(1)}%`);
  rollBackground(topY);
  inRoll(topY, () => {
    for (const place of p.baselineLayout) {
      const sprite = sprites.get(place.id);
      if (!sprite) continue;
      const box = boundsOf(sprite, place);
      ctx.fillStyle = "rgba(240,80,110,0.26)";
      ctx.fillRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = "rgba(240,80,110,0.65)";
      ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    }
    for (const place of p.baselineLayout) {
      const sprite = sprites.get(place.id);
      if (!sprite) continue;
      trace(poseOf(sprite, place), () => {
        ctx.fillStyle = "#3a4b5e";
        ctx.fill(sprite.path, "evenodd");
      });
    }
    drawDefects(ctx, p.defects, scale, s, p.mode === "defects");
  });
  if (X(baseLen) <= left + stripW + 1) cutMarker(X(baseLen), topY, "#f0506e", false);

  // ---------------- Bottom roll: live CutZero nest ----------------
  const hasRun = p.optimizedLayout !== null;
  const cut = state.cutLine || p.optimizedLength || baseLen;
  const optUtil = hasRun ? (100 * p.pieces.reduce((t, c) => t + c.area_mm2, 0)) / (p.rollWidth * cut) : 0;
  header(
    bottomY,
    "#2fd6a0",
    p.running ? "CutZero engine: searching live" : hasRun ? "CutZero engine: nested layout" : "CutZero engine: ready to nest",
    hasRun ? `${Math.round(cut).toLocaleString("en-US")} mm · η ${optUtil.toFixed(1)}%` : "press Run",
  );
  rollBackground(bottomY);
  inRoll(bottomY, () => {
    // Saved zone sits under the pieces so sprites gliding in stay legible.
    if (hasRun && cut < baseLen) {
      ctx.fillStyle = "rgba(47,214,160,0.09)";
      ctx.fillRect(cut, 0, baseLen - cut, p.rollWidth);
    }
    const layout = p.optimizedLayout ?? p.baselineLayout;
    const hoverId = state.hoverId;
    for (const place of layout) {
      const sprite = sprites.get(place.id);
      const pose = state.poses.get(place.id);
      if (!sprite || !pose) continue;
      trace(pose, () => {
        ctx.globalAlpha = hasRun ? 1 : 0.28;
        if (p.mode === "radar" || p.mode === "toolpath") ctx.globalAlpha = 0.45;
        if (p.mode === "radar" && place.id === p.radarPieceId) ctx.globalAlpha = 0.12;
        ctx.fillStyle = sprite.color;
        ctx.fill(sprite.path, "evenodd");
        ctx.globalAlpha = 1;
        ctx.lineWidth = (hoverId === place.id ? 1.6 : 0.6) / scale;
        ctx.strokeStyle = hoverId === place.id ? "#ffffff" : "rgba(7,11,16,0.75)";
        ctx.stroke(sprite.path);
      });
    }
    if (p.showInterlocks && p.done && p.mode === "view" && p.optimizedLayout) {
      drawInterlocks(ctx, sprites, p.optimizedLayout, scale);
    }
    drawDefects(ctx, p.defects, scale, s, p.mode === "defects");
    if (p.mode === "radar" && p.radar) drawRadar(ctx, state, p.radar);
    if (state.toolpath) drawToolpath(ctx, state, now, scale);
  });

  if (hasRun && cut < baseLen - 0.5) {
    const x0 = Math.max(left, X(cut));
    const x1 = Math.min(left + stripW, X(baseLen));
    if (x1 > x0) {
      if (!state.hatch) state.hatch = hatchPattern(ctx, dpr);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = state.hatch!;
      ctx.fillRect(x0 * dpr, bottomY * dpr, (x1 - x0) * dpr, rollH * dpr);
      ctx.restore();

      const zone = x1 - x0;
      const saved = baseLen - cut;
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = "#e6ecf2";
      if (zone > rollH * 0.55) {
        ctx.font = "600 11px 'Inter Variable', sans-serif";
        ctx.fillText("SAVED MATERIAL ZONE", (x0 + x1) / 2, bottomY + rollH / 2 - 8);
        ctx.font = "600 13px 'JetBrains Mono', monospace";
        ctx.fillStyle = "#2fd6a0";
        ctx.fillText(`ΔL ${Math.round(saved).toLocaleString("en-US")} mm`, (x0 + x1) / 2, bottomY + rollH / 2 + 10);
      } else {
        // Too narrow for horizontal type: run it up the zone instead.
        ctx.translate((x0 + x1) / 2 + 4, bottomY + rollH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = "600 11px 'Inter Variable', sans-serif";
        ctx.fillText(`SAVED MATERIAL ZONE  ΔL ${Math.round(saved).toLocaleString("en-US")} mm`, 0, 0);
      }
      ctx.restore();
    }
    if (X(baseLen) <= left + stripW + 1) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(240,80,110,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(baseLen), bottomY);
      ctx.lineTo(X(baseLen), bottomY + rollH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (X(cut) >= left && X(cut) <= left + stripW) cutMarker(X(cut), bottomY, "#2fd6a0", true);
  }
  ruler(bottomY + rollH + 3);
  ruler(topY + rollH + 3);
}

/** Flaws are drawn in roll millimetres; the X keeps them legible however far the view is zoomed. */
function drawDefects(ctx: CanvasRenderingContext2D, defects: Defect[], scaleY: number, scaleX: number, editing: boolean) {
  for (const d of defects) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(d.x, d.y, d.r, d.r, 0, 0, 2 * Math.PI);
    ctx.fillStyle = editing ? "rgba(255,77,77,0.55)" : "rgba(255,77,77,0.42)";
    ctx.fill();
    ctx.lineWidth = 1.6 / scaleY;
    ctx.strokeStyle = "#ff5a5a";
    ctx.stroke();
    const k = d.r * 0.55;
    ctx.beginPath();
    ctx.moveTo(d.x - k, d.y - k);
    ctx.lineTo(d.x + k, d.y + k);
    ctx.moveTo(d.x + k, d.y - k);
    ctx.lineTo(d.x - k, d.y + k);
    ctx.lineWidth = 1.4 / Math.min(scaleX, scaleY);
    ctx.strokeStyle = "#ffe4e4";
    ctx.stroke();
    ctx.restore();
  }
}

function drawInterlocks(ctx: CanvasRenderingContext2D, sprites: Map<number, Sprite>, layout: Placement[], scale: number) {
  const boxes = layout.flatMap((place) => {
    const sprite = sprites.get(place.id);
    return sprite ? [boundsOf(sprite, place)] : [];
  });
  ctx.fillStyle = "rgba(245,184,61,0.2)";
  ctx.strokeStyle = "rgba(245,184,61,0.7)";
  ctx.lineWidth = 1 / scale;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const x0 = Math.max(a.minX, b.minX);
      const x1 = Math.min(a.maxX, b.maxX);
      const y0 = Math.max(a.minY, b.minY);
      const y1 = Math.min(a.maxY, b.maxY);
      if (x1 > x0 + 1 && y1 > y0 + 1) {
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }
}

function drawRadar(ctx: CanvasRenderingContext2D, state: LiveState, radar: RadarResult) {
  const { rows, cols: allCols, cell_mm: c, margin, free } = radar;
  // Open roll past the cut-line is trivially free, so it is drawn faintly; pockets inside the
  // nest, where the part would fit without lengthening the roll, are drawn bright.
  const limit = state.props.optimizedLength ?? Infinity;
  const inside = Math.max(0, Math.min(allCols, Math.floor((limit - radar.piece_w) / c) - margin + 1));
  const spans = (from: number, to: number, color: string, grow: number) => {
    ctx.fillStyle = color;
    for (let dy = 0; dy < rows; dy++) {
      let dx = from;
      while (dx < to) {
        if (!free[dy * allCols + dx]) {
          dx++;
          continue;
        }
        const start = dx;
        while (dx < to && free[dy * allCols + dx]) dx++;
        ctx.fillRect((start + margin) * c - grow, (dy + margin) * c - grow, (dx - start) * c + 2 * grow, c + 2 * grow);
      }
    }
  };
  spans(inside, allCols, "rgba(47,214,160,0.16)", 0);
  // A grid cell can be under two screen pixels wide, so interior pockets get a halo to stay visible.
  const halo = Math.max(0, 2.5 / state.scale - c / 2);
  spans(0, inside, "rgba(47,214,160,0.35)", halo);
  spans(0, inside, "rgba(110,255,200,0.95)", 0);
  // Ghost of the picked piece, snapped to the offset under the pointer.
  const pointer = state.pointer;
  const id = state.props.radarPieceId;
  const sprite = id !== null ? state.sprites.get(id) : undefined;
  const place = state.props.optimizedLayout?.find((q) => q.id === id);
  if (!pointer || !sprite || !place) return;
  const dx = Math.floor(pointer[0] / c) - margin;
  const dy = Math.floor(pointer[1] / c) - margin;
  if (dx < 0 || dy < 0 || dx >= allCols || dy >= rows) return;
  const ok = free[dy * allCols + dx] === 1;
  const box = boundsOf(sprite, place);
  const target: Placement = {
    ...place,
    tx: place.tx - box.minX + (dx + margin) * c,
    ty: place.ty - box.minY + (dy + margin) * c,
  };
  const pose = poseOf(sprite, target);
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.a);
  ctx.fillStyle = ok ? "rgba(47,214,160,0.85)" : "rgba(240,80,110,0.8)";
  ctx.fill(sprite.path, "evenodd");
  ctx.lineWidth = 1.5 / state.scale;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(sprite.path);
  ctx.restore();
}

const TOOLPATH_MS = 11000;

function drawToolpath(ctx: CanvasRenderingContext2D, state: LiveState, now: number, scale: number) {
  const tp = state.toolpath!;
  const t = Math.min(1, (now - tp.started) / TOOLPATH_MS);
  let remaining = t * tp.total;
  let head: Pt = [0, 0];
  let prevEnd: Pt = [0, 0];

  ctx.lineWidth = 2 / scale;
  ctx.lineJoin = "round";
  for (const contour of tp.contours) {
    if (remaining <= 0) break;
    const ring = contour.ring;
    // Rapid travel: dashed, beam off.
    ctx.save();
    ctx.setLineDash([6 / scale, 6 / scale]);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = "rgba(196,208,219,0.55)";
    ctx.beginPath();
    ctx.moveTo(prevEnd[0], prevEnd[1]);
    ctx.lineTo(ring[0][0], ring[0][1]);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = "#f5b83d";
    ctx.beginPath();
    ctx.moveTo(ring[0][0], ring[0][1]);
    head = ring[0];
    for (let i = 0; i < ring.length && remaining > 0; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len <= remaining) {
        ctx.lineTo(b[0], b[1]);
        head = b;
        remaining -= len;
      } else {
        const f = remaining / len;
        head = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        ctx.lineTo(head[0], head[1]);
        remaining = 0;
      }
    }
    ctx.stroke();
    prevEnd = ring[0];
  }
  ctx.save();
  ctx.shadowColor = "#fff4cf";
  ctx.shadowBlur = 16;
  ctx.fillStyle = "#fff4cf";
  ctx.beginPath();
  ctx.arc(head[0], head[1], 5 / scale, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();

  if (t >= 1) state.props.onToolpathEnd();
}
