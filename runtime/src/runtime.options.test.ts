import { describe, expect, it } from "bun:test";
import { createLoadSource, type AidokuRuntimeOptions, type CanvasModule } from "./runtime";
import { buildWasm, op, type WasmModuleSpec } from "./testing/wasm-builder";
import type { HttpBridge, SourceManifest } from "./types";

const stubCanvasModule: CanvasModule = {
  createCanvasImports: () => ({}),
  createHostImage: async () => null,
  getHostImageData: () => null,
};

const stubHttpBridge: HttpBridge = {
  request: () => ({ status: 200, headers: {}, body: "", bytes: null }),
};

const manifest: SourceManifest = {
  info: { id: "test.options", name: "Options Source", version: 1 },
};

const loadSource = createLoadSource(stubCanvasModule);

function load(spec: WasmModuleSpec, options: Partial<AidokuRuntimeOptions> = {}) {
  return loadSource({ wasmBytes: buildWasm(spec), manifest }, "test.options", {
    httpBridge: stubHttpBridge,
    ...options,
  });
}

describe("clock option", () => {
  it("routes env.sleep through the host clock", async () => {
    const slept: number[] = [];
    const source = await load(
      {
        imports: [{ module: "env", name: "sleep", params: 1, results: 0 }],
        functions: [
          { name: "start", params: 0, results: 0, body: [...op.i32Const(3), ...op.call(0)] },
        ],
      },
      { clock: { sleep: (seconds) => slept.push(seconds) } }
    );

    source.initialize();
    expect(slept).toEqual([3]);
  });
});
