import { describe, expect, it } from "bun:test";
import { createLoadSource, type AidokuSource, type CanvasModule } from "./runtime";
import { BROWSER_USER_AGENT } from "./imports/net";
import { buildWasm, framedResult, op, type WasmFunctionSpec, type WasmImportSpec } from "./testing/wasm-builder";
import type { HttpBridge, SourceManifest } from "./types";

const KEY_TEXT = "User-Agent";
const KEY_PTR = 64;
const VALUE_TEXT = "Aidoku";
const VALUE_PTR = 96;
const RESULT_PTR = 128;

const stubCanvasModule: CanvasModule = {
  createCanvasImports: () => ({}),
  createHostImage: async () => ({ rid: 1, width: 1, height: 1 }),
  getHostImageData: () => null,
};

const bridge: HttpBridge = {
  request: () => ({ status: 200, headers: {}, body: "", bytes: null }),
};

const manifest: SourceManifest = {
  info: { id: "test.user-agent", name: "User-Agent Source", version: 1 },
};

const netImports: WasmImportSpec[] = [
  { module: "net", name: "init", params: 1, results: 1 },
  { module: "net", name: "set_header", params: 5, results: 1 },
];

/** get_image_request returning a new request, with the source's UA if `setUserAgent`. */
function imageRequest(setUserAgent: boolean): WasmFunctionSpec {
  const rid = 2; // first local after the url and context descriptors
  return {
    name: "get_image_request",
    params: 2,
    results: 1,
    locals: 1,
    body: [
      ...op.i32Const(0),
      ...op.call(0),
      ...op.localSet(rid),
      ...(setUserAgent
        ? [
            ...op.localGet(rid),
            ...op.i32Const(KEY_PTR),
            ...op.i32Const(KEY_TEXT.length),
            ...op.i32Const(VALUE_PTR),
            ...op.i32Const(VALUE_TEXT.length),
            ...op.call(1),
            ...op.drop(),
          ]
        : []),
      // Result payload: the request descriptor, zigzag-encoded in one byte.
      ...op.i32Const(RESULT_PTR),
      ...op.localGet(rid),
      ...op.i32Const(1),
      ...op.i32Shl(),
      ...op.i32Store8(8),
      ...op.i32Const(RESULT_PTR),
    ],
  };
}

function load(functions: WasmFunctionSpec[]): Promise<AidokuSource> {
  const encode = (text: string) => new TextEncoder().encode(text);
  const wasmBytes = buildWasm({
    imports: netImports,
    functions,
    data: [
      { offset: KEY_PTR, bytes: encode(KEY_TEXT) },
      { offset: VALUE_PTR, bytes: encode(VALUE_TEXT) },
      { offset: RESULT_PTR, bytes: framedResult([0]) },
    ],
  });
  return createLoadSource(stubCanvasModule)({ wasmBytes, manifest }, "test.user-agent", {
    httpBridge: bridge,
  });
}

describe("image request User-Agent", () => {
  it("defaults to the browser User-Agent", async () => {
    const source = await load([imageRequest(false)]);
    expect(source.modifyImageRequest("https://example.com/p.jpg").headers).toEqual({
      "User-Agent": BROWSER_USER_AGENT,
    });
  });

  it("keeps the source's User-Agent", async () => {
    const source = await load([imageRequest(true)]);
    expect(source.modifyImageRequest("https://example.com/p.jpg").headers).toEqual({
      "User-Agent": "Aidoku",
    });
  });

  it("defaults to the browser User-Agent for legacy sources", async () => {
    const source = await load([
      { name: "get_manga_details", params: 1, results: 1, body: [0x00] },
      { name: "modify_image_request", params: 1, results: 0, body: [] },
    ]);
    expect(source.modifyImageRequest("https://example.com/p.jpg").headers).toEqual({
      "User-Agent": BROWSER_USER_AGENT,
    });
  });
});
