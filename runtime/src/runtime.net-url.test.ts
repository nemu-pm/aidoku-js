import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createLoadSource, type AidokuSource, type CanvasModule } from "./runtime";
import { buildWasm, op, type WasmFunctionSpec, type WasmImportSpec } from "./testing/wasm-builder";
import type { HttpBridge, SourceManifest } from "./types";

const REQUEST_URL = "https://example.com/start";
const FINAL_URL = "https://example.com/final/page";
const URL_PTR = 64;
const OUT_PTR = 256;

const redirectingBridge: HttpBridge = {
  request: () => ({ status: 200, headers: {}, body: "ok", bytes: null, url: FINAL_URL }),
};

const stubCanvasModule: CanvasModule = {
  createCanvasImports: () => ({}),
  createHostImage: async () => ({ rid: 1, width: 1, height: 1 }),
  getHostImageData: () => null,
};

const manifest: SourceManifest = {
  info: { id: "test.net-url", name: "Net URL Source", version: 1 },
};

const imports: WasmImportSpec[] = [
  { module: "net", name: "init", params: 1, results: 1 },
  { module: "net", name: "set_url", params: 3, results: 1 },
  { module: "net", name: "send", params: 1, results: 1 },
  { module: "net", name: "get_url", params: 1, results: 1 },
  { module: "std", name: "buffer_len", params: 1, results: 1 },
  { module: "std", name: "read_buffer", params: 3, results: 1 },
  { module: "std", name: "print", params: 2, results: 0 },
];

/** `start`: request REQUEST_URL, optionally send it, then print net.get_url. */
function printingUrl(send: boolean): WasmFunctionSpec {
  const [rid, urlRid, len] = [0, 1, 2];
  return {
    name: "start",
    params: 0,
    results: 0,
    locals: 3,
    body: [
      ...op.i32Const(0),
      ...op.call(0),
      ...op.localSet(rid),
      ...op.localGet(rid),
      ...op.i32Const(URL_PTR),
      ...op.i32Const(REQUEST_URL.length),
      ...op.call(1),
      ...op.drop(),
      ...(send ? [...op.localGet(rid), ...op.call(2), ...op.drop()] : []),
      ...op.localGet(rid),
      ...op.call(3),
      ...op.localSet(urlRid),
      ...op.localGet(urlRid),
      ...op.call(4),
      ...op.localSet(len),
      ...op.localGet(urlRid),
      ...op.i32Const(OUT_PTR),
      ...op.localGet(len),
      ...op.call(5),
      ...op.drop(),
      ...op.i32Const(OUT_PTR),
      ...op.localGet(len),
      ...op.call(6),
    ],
  };
}

/** Its presence makes the runtime treat the module as a legacy source. */
const legacyMarker: WasmFunctionSpec = { name: "get_manga_details", params: 1, results: 1, body: [0x00] };

function load(functions: WasmFunctionSpec[]): Promise<AidokuSource> {
  const wasmBytes = buildWasm({
    imports,
    functions,
    data: [{ offset: URL_PTR, bytes: new TextEncoder().encode(REQUEST_URL) }],
  });
  return createLoadSource(stubCanvasModule)({ wasmBytes, manifest }, "test.net-url", {
    httpBridge: redirectingBridge,
  });
}

describe("net.get_url in a loaded source", () => {
  let originalLog: typeof console.log;
  let printed: string[];

  beforeEach(() => {
    originalLog = console.log;
    printed = [];
    console.log = (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("instantiates a module importing net.get_url and returns the final URL", async () => {
    const source = await load([printingUrl(true)]);
    expect(source.mode).toBe("aidoku-rs");
    source.initialize();
    expect(printed).toContain(`[test.net-url] ${FINAL_URL}`);
  });

  it("returns the request URL for a legacy source", async () => {
    const source = await load([printingUrl(true), legacyMarker]);
    expect(source.mode).toBe("legacy");
    source.initialize();
    expect(printed).toContain(`[test.net-url] ${REQUEST_URL}`);
  });

  it("returns the request URL for a legacy source before sending", async () => {
    const source = await load([printingUrl(false), legacyMarker]);
    source.initialize();
    expect(printed).toContain(`[test.net-url] ${REQUEST_URL}`);
  });
});
