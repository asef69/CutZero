/// <reference lib="webworker" />
// Runs the C++20 engine as WebAssembly inside a worker. The solve is synchronous from the
// worker's point of view; every frame is posted to the page as soon as the engine emits it.

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  cz_alloc(doubles: number): number;
  cz_free(ptr: number): void;
  cz_output(): number;
  cz_output_size(): number;
  cz_solve(ptr: number): number;
  cz_baseline(ptr: number): number;
  cz_radar(ptr: number): number;
}

let wasm: Exports | null = null;

const decoder = new TextDecoder();

async function load(url: string): Promise<Exports> {
  if (wasm) return wasm;
  const imports: WebAssembly.Imports = {
    env: {
      cz_frame(ptr: number, count: number): number {
        const data = new Float64Array(wasm!.memory.buffer, ptr, count).slice();
        (self as unknown as Worker).postMessage({ type: "frame", data }, [data.buffer]);
        return 1;
      },
    },
    wasi_snapshot_preview1: {
      clock_time_get(_id: number, _precision: bigint, out: number): number {
        new DataView(wasm!.memory.buffer).setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
        return 0;
      },
      fd_write(fd: number, iovs: number, iovsLen: number, written: number): number {
        const view = new DataView(wasm!.memory.buffer);
        let total = 0;
        let text = "";
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          text += decoder.decode(new Uint8Array(wasm!.memory.buffer, ptr, len));
          total += len;
        }
        view.setUint32(written, total, true);
        if (text) console.warn(`[cutzero wasm fd ${fd}]`, text);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 0,
    },
  };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the engine (${response.status}).`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
  wasm = instance.exports as unknown as Exports;
  wasm._initialize?.();
  return wasm;
}

function call(name: "cz_solve" | "cz_baseline" | "cz_radar", input: Float64Array): Float64Array {
  const engine = wasm!;
  const ptr = engine.cz_alloc(input.length);
  new Float64Array(engine.memory.buffer, ptr, input.length).set(input);
  const code = engine[name](ptr);
  engine.cz_free(ptr);
  if (code !== 0) {
    throw new Error(
      code === 1 ? "A piece does not fit across the roll at any allowed rotation." : "The engine rejected this request.",
    );
  }
  return new Float64Array(engine.memory.buffer, engine.cz_output(), engine.cz_output_size()).slice();
}

self.onmessage = async (event: MessageEvent) => {
  const { id, op, input, url } = event.data as {
    id: number;
    op: "solve" | "baseline" | "radar";
    input: Float64Array;
    url: string;
  };
  try {
    await load(url);
    const name = op === "solve" ? "cz_solve" : op === "baseline" ? "cz_baseline" : "cz_radar";
    const output = call(name, input);
    (self as unknown as Worker).postMessage({ type: "done", id, output }, [output.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ type: "error", id, message: (error as Error).message });
  }
};
