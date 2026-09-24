import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createLoadSource, type AidokuSource, type CanvasModule } from "./runtime";
import { CloudflareBlockedError } from "./imports/net";
import { buildWasm, op, type WasmFunctionSpec, type WasmImportSpec } from "./testing/wasm-builder";
import type { HttpBridge, SourceManifest } from "./types";

const CHALLENGE_BODY = "<html><head><title>Just a moment...</title></head></html>";
const URL_TEXT = "https://example.com/manga/1";
const URL_PTR = 64;

const challengeBridge: HttpBridge = {
  request: () => ({
    status: 403,
    headers: { server: "cloudflare" },
    body: CHALLENGE_BODY,
    bytes: null,
  }),
};

const stubCanvasModule: CanvasModule = {
  createCanvasImports: () => ({}),
  createHostImage: async () => ({ rid: 1, width: 1, height: 1 }),
  getHostImageData: () => null,
};

const manifest: SourceManifest = {
  info: { id: "test.cloudflare", name: "Cloudflare Source", version: 1 },
};

const netImports: WasmImportSpec[] = [
  { module: "net", name: "init", params: 1, results: 1 },
  { module: "net", name: "set_url", params: 3, results: 1 },
  { module: "net", name: "send", params: 1, results: 1 },
];

/** An export that requests URL_TEXT (which the bridge answers with a challenge). */
function fetching(name: string, params: number, results: 0 | 1): WasmFunctionSpec {
  const rid = params; // first local after the parameters
  return {
    name,
    params,
    results,
    locals: 1,
    body: [
      ...op.i32Const(0),
      ...op.call(0),
      ...op.localSet(rid),
      ...op.localGet(rid),
      ...op.i32Const(URL_PTR),
      ...op.i32Const(URL_TEXT.length),
      ...op.call(1),
      ...op.drop(),
      ...op.localGet(rid),
      ...op.call(2),
      ...op.drop(),
      ...(results ? op.i32Const(0) : []),
    ],
  };
}

/** An export that traps, standing in for any non-Cloudflare failure. */
function trapping(name: string, params: number, results: 0 | 1): WasmFunctionSpec {
  return { name, params, results, body: [0x00] };
}

function load(functions: WasmFunctionSpec[]): Promise<AidokuSource> {
  const wasmBytes = buildWasm({
    imports: netImports,
    functions,
    data: [{ offset: URL_PTR, bytes: new TextEncoder().encode(URL_TEXT) }],
  });
  return createLoadSource(stubCanvasModule)({ wasmBytes, manifest }, "test.cloudflare", {
    httpBridge: challengeBridge,
  });
}

const image = new Uint8Array([1, 2, 3]);

describe("Cloudflare challenges in lenient calls", () => {
  let originalError: typeof console.error;

  beforeEach(() => {
    originalError = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("propagates from initialize", async () => {
    const source = await load([fetching("start", 0, 0)]);
    expect(() => source.initialize()).toThrow(CloudflareBlockedError);
  });

  it("propagates from getFilters and getListings", async () => {
    const source = await load([fetching("get_filters", 0, 1), fetching("get_listings", 0, 1)]);
    expect(() => source.getFilters()).toThrow(CloudflareBlockedError);
    expect(() => source.getListings()).toThrow(CloudflareBlockedError);
  });

  it("propagates from modifyImageRequest", async () => {
    const source = await load([fetching("get_image_request", 2, 1)]);
    expect(() => source.modifyImageRequest("https://example.com/p.jpg")).toThrow(
      CloudflareBlockedError
    );
  });

  it("propagates from the legacy modify_image_request", async () => {
    const source = await load([
      trapping("get_manga_details", 1, 1),
      fetching("modify_image_request", 1, 0),
    ]);
    expect(() => source.modifyImageRequest("https://example.com/p.jpg")).toThrow(
      CloudflareBlockedError
    );
  });

  it("propagates from the image processors", async () => {
    const source = await load([
      fetching("process_page_image", 2, 1),
      fetching("process_cover_image", 1, 1),
    ]);
    await expect(
      source.processPageImage(image, null, "https://example.com/p.jpg", {}, 200, {})
    ).rejects.toBeInstanceOf(CloudflareBlockedError);
    await expect(
      source.processCoverImage(image, "https://example.com/c.jpg", {}, 200, {})
    ).rejects.toBeInstanceOf(CloudflareBlockedError);
  });

  it("still swallows other failures in the same calls", async () => {
    const source = await load([
      trapping("start", 0, 0),
      trapping("get_filters", 0, 1),
      trapping("get_listings", 0, 1),
      trapping("get_image_request", 2, 1),
      trapping("process_page_image", 2, 1),
    ]);

    expect(() => source.initialize()).not.toThrow();
    expect(source.getFilters()).toEqual([]);
    expect(source.getListings()).toEqual([]);
    expect(source.modifyImageRequest("https://example.com/p.jpg").url).toBe(
      "https://example.com/p.jpg"
    );
    expect(
      await source.processPageImage(image, null, "https://example.com/p.jpg", {}, 200, {})
    ).toBeNull();
  });
});
