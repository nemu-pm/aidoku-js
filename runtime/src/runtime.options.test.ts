import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createLoadSource, type AidokuRuntimeOptions, type CanvasModule } from "./runtime";
import { GlobalStore } from "./global-store";
import { buildWasm, framedResult, op, type WasmModuleSpec } from "./testing/wasm-builder";
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

describe("compiledModule option", () => {
  const spies: { mockRestore(): void }[] = [];

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  // get_filters returns a framed empty list, so each instance is exercised.
  const spec: WasmModuleSpec = {
    functions: [{ name: "get_filters", params: 0, results: 1, body: op.i32Const(16) }],
    data: [{ offset: 16, bytes: framedResult([0x00]) }],
  };

  it("instantiates a precompiled module without compiling again", async () => {
    const wasmBytes = buildWasm(spec);
    const compiledModule = await WebAssembly.compile(wasmBytes);
    const compile = spyOn(WebAssembly, "compile");
    const instantiate = spyOn(WebAssembly, "instantiate");
    spies.push(compile, instantiate);

    const first = await loadSource({ wasmBytes, manifest }, "test.options", {
      httpBridge: stubHttpBridge,
      compiledModule,
    });
    const second = await loadSource({ wasmBytes, manifest }, "test.options", {
      httpBridge: stubHttpBridge,
      compiledModule,
    });

    expect(compile).not.toHaveBeenCalled();
    expect(instantiate).not.toHaveBeenCalled();
    expect(first.getFilters()).toEqual([]);
    expect(second.getFilters()).toEqual([]);
  });

  it("gives each load its own memory", async () => {
    const wasmBytes = buildWasm(spec);
    const compiledModule = await WebAssembly.compile(wasmBytes);
    const memories: WebAssembly.Memory[] = [];
    const setMemory = spyOn(GlobalStore.prototype, "setMemory").mockImplementation(function (
      this: GlobalStore,
      memory: WebAssembly.Memory
    ) {
      memories.push(memory);
      this.memory = memory;
    });
    spies.push(setMemory);

    await load(spec, { compiledModule });
    await load(spec, { compiledModule });

    expect(memories).toHaveLength(2);
    expect(memories[0]).not.toBe(memories[1]);
  });

  it("still compiles the bytes when no module is given", async () => {
    const compile = spyOn(WebAssembly, "compile");
    spies.push(compile);

    await load(spec);

    expect(compile).toHaveBeenCalledTimes(1);
  });
});

describe("dispose", () => {
  it("destroys the source's store", async () => {
    const destroy = spyOn(GlobalStore.prototype, "destroy");
    try {
      const source = await load({ functions: [] });
      expect(destroy).not.toHaveBeenCalled();

      source.dispose();

      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
    }
  });
});
