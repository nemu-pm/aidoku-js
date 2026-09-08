import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildLegacyListingValue,
  callLegacyMangaListing,
  createLoadSource,
  decodeLegacyMangaPageResult,
  detectListingProvider,
  type AidokuRuntimeOptions,
  type CanvasModule,
} from "./runtime";
import { GlobalStore } from "./global-store";
import { CloudflareBlockedError, DEFAULT_USER_AGENT } from "./imports/net";
import { AidokuResultError, RuntimeMode } from "./result-decoder";
import { ListingKind, type HttpBridge, type SourceManifest } from "./types";

/** Stand-in for a WASM export table; only membership/callability matters. */
function fakeExports(names: string[]): Record<string, WebAssembly.ExportValue> {
  const exports: Record<string, WebAssembly.ExportValue> = {};
  for (const name of names) {
    exports[name] = (() => 0) as unknown as WebAssembly.ExportValue;
  }
  return exports;
}

describe("detectListingProvider", () => {
  it("reports aidoku-rs sources exporting get_manga_list", () => {
    const exports = fakeExports(["get_search_manga_list", "get_manga_list"]);
    expect(detectListingProvider(exports, RuntimeMode.AidokuRs)).toBe(true);
  });

  it("reports legacy sources exporting get_manga_listing", () => {
    const exports = fakeExports(["get_manga_list", "get_manga_details", "get_manga_listing"]);
    expect(detectListingProvider(exports, RuntimeMode.Legacy)).toBe(true);
  });

  it("does not treat the legacy search export as a listing provider", () => {
    // OLD ABI `get_manga_list(filters, page)` is search, not listings.
    const exports = fakeExports(["get_manga_list", "get_manga_details", "get_chapter_list"]);
    expect(detectListingProvider(exports, RuntimeMode.Legacy)).toBe(false);
  });

  it("ignores get_manga_listing on aidoku-rs sources", () => {
    const exports = fakeExports(["get_search_manga_list", "get_manga_listing"]);
    expect(detectListingProvider(exports, RuntimeMode.AidokuRs)).toBe(false);
  });
});

describe("buildLegacyListingValue", () => {
  it("exposes the name key the legacy ABI reads", () => {
    expect(buildLegacyListingValue({ id: "popular", name: "人气榜" })).toEqual({
      name: "人气榜",
      flags: 0,
    });
  });

  it("ignores the new-ABI listing kind", () => {
    expect(
      buildLegacyListingValue({ id: "latest", name: "Latest", kind: ListingKind.List })
    ).toEqual({ name: "Latest", flags: 0 });
  });

  it("keeps the name a string so ObjectRef::get(\"name\").as_string() succeeds", () => {
    const value = buildLegacyListingValue({ id: "", name: "" });
    expect(typeof value.name).toBe("string");
  });
});

describe("decodeLegacyMangaPageResult", () => {
  it("decodes Swift-era manga keys", () => {
    const result = decodeLegacyMangaPageResult(
      {
        entries: [
          {
            id: "/comic/123",
            title: "Test Manga",
            author: "Author A",
            artist: "Artist A",
            description: "desc",
            tags: ["Action"],
            cover: "https://example.com/cover.jpg",
            url: "https://example.com/comic/123",
            status: 1,
            nsfw: 0,
            viewer: 2,
          },
        ],
        hasNextPage: true,
      },
      "zh.mkzhan"
    );

    expect(result.hasNextPage).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      sourceId: "zh.mkzhan",
      id: "/comic/123",
      key: "/comic/123",
      title: "Test Manga",
      authors: ["Author A"],
      artists: ["Artist A"],
      description: "desc",
      tags: ["Action"],
      cover: "https://example.com/cover.jpg",
      url: "https://example.com/comic/123",
      status: 1,
      nsfw: 0,
      viewer: 2,
    });
  });

  it("prefers key over id and falls back to an empty key", () => {
    const result = decodeLegacyMangaPageResult(
      { entries: [{ key: "k1", id: "i1" }, {}] },
      "zh.mkzhan"
    );
    expect(result.entries.map((m) => m.key)).toEqual(["k1", ""]);
    expect(result.hasNextPage).toBe(false);
  });

  it("returns an empty result for missing or empty values", () => {
    expect(decodeLegacyMangaPageResult(null, "zh.mkzhan")).toEqual({
      entries: [],
      hasNextPage: false,
    });
    expect(decodeLegacyMangaPageResult(undefined, "zh.mkzhan")).toEqual({
      entries: [],
      hasNextPage: false,
    });
    expect(decodeLegacyMangaPageResult({}, "zh.mkzhan")).toEqual({
      entries: [],
      hasNextPage: false,
    });
  });
});

describe("callLegacyMangaListing", () => {
  let store: GlobalStore;

  beforeEach(() => {
    store = new GlobalStore("zh.mkzhan");
  });

  afterEach(() => {
    store.destroy();
  });

  it("passes the listing object and page to the export and decodes the result", () => {
    let seenListing: unknown;
    let seenPage: number | undefined;

    const result = callLegacyMangaListing(
      store,
      (listingDescriptor, page) => {
        seenListing = store.readStdValue(listingDescriptor);
        seenPage = page;
        return store.storeStdValue({
          entries: [{ id: "/comic/1", title: "One" }],
          hasNextPage: true,
        });
      },
      { id: "popular", name: "人气榜" },
      3,
      "zh.mkzhan"
    );

    expect(seenListing).toEqual({ name: "人气榜", flags: 0 });
    expect(seenPage).toBe(3);
    expect(result).toEqual({
      entries: [
        {
          sourceId: "zh.mkzhan",
          id: "/comic/1",
          key: "/comic/1",
          title: "One",
          authors: undefined,
          artists: undefined,
          description: undefined,
          tags: undefined,
          cover: undefined,
          url: undefined,
          status: undefined,
          nsfw: undefined,
          viewer: undefined,
        },
      ],
      hasNextPage: true,
    });
  });

  it("releases the listing and result descriptors", () => {
    const before = store.getStats().descriptorCount;

    callLegacyMangaListing(
      store,
      () => store.storeStdValue({ entries: [], hasNextPage: false }),
      { id: "popular", name: "人气榜" },
      1,
      "zh.mkzhan"
    );

    expect(store.getStats().descriptorCount).toBe(before);
  });

  it("returns an empty result when the export signals failure", () => {
    let listingDescriptor = -1;

    const result = callLegacyMangaListing(
      store,
      (descriptor) => {
        listingDescriptor = descriptor;
        return -1;
      },
      { id: "popular", name: "人气榜" },
      1,
      "zh.mkzhan"
    );

    expect(result).toEqual({ entries: [], hasNextPage: false });
    // The listing descriptor is still cleaned up on the failure path.
    expect(store.readStdValue(listingDescriptor)).toBeUndefined();
  });

  it("rethrows Cloudflare blocks so the retry wrapper can handle them", () => {
    expect(() =>
      callLegacyMangaListing(
        store,
        () => {
          throw new CloudflareBlockedError("https://example.com", 403);
        },
        { id: "popular", name: "人气榜" },
        1,
        "zh.mkzhan"
      )
    ).toThrow(CloudflareBlockedError);
  });

  it("swallows other errors into an empty result", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = callLegacyMangaListing(
        store,
        () => {
          throw new Error("wasm trap");
        },
        { id: "popular", name: "人气榜" },
        1,
        "zh.mkzhan"
      );
      expect(result).toEqual({ entries: [], hasNextPage: false });
    } finally {
      console.error = originalError;
    }
  });
});


/** Result pointer whose payload decodes to image ref RID 1. */
const IMAGE_RESULT_PTR = 16;
/** Pointer to a Message error buffer. */
const MESSAGE_RESULT_PTR = 64;
const MESSAGE_TEXT = "no chapters found";

interface WasmExportSpec {
  name: string;
  /** Number of i32 parameters the export takes */
  arity: 0 | 1 | 2 | 3;
  /** Constant the export returns */
  returns: number;
}

function encodeSignedLeb(value: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done =
      (value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

/**
 * Minimal WASM module exporting memory plus the requested functions, each
 * returning a fixed constant. Two data segments are laid down: a successful
 * image ref result at IMAGE_RESULT_PTR, and a Message error buffer at
 * MESSAGE_RESULT_PTR.
 */
function buildSourceWasm(specs: WasmExportSpec[]): Uint8Array {
  const name = (value: string) => [
    ...encodeSignedLeb(value.length),
    ...Array.from(new TextEncoder().encode(value)),
  ];
  const section = (id: number, content: number[]) => [
    id,
    ...encodeSignedLeb(content.length),
    ...content,
  ];

  // one type per arity: () -> i32 ... (i32, i32, i32) -> i32
  const types = section(1, [
    0x04,
    ...[0, 1, 2, 3].flatMap((arity) => [
      0x60,
      arity,
      ...new Array(arity).fill(0x7f),
      0x01,
      0x7f,
    ]),
  ]);
  const functions = section(3, [specs.length, ...specs.map((spec) => spec.arity)]);
  const memory = section(5, [0x01, 0x00, 0x01]);

  const exportEntries = [
    ...name("memory"),
    0x02,
    0x00,
    ...specs.flatMap((spec, index) => [...name(spec.name), 0x00, index]),
  ];
  const exports = section(7, [specs.length + 1, ...exportEntries]);

  const bodies = specs.flatMap((spec) => {
    // i32.const <returns>; end
    const body = [0x00, 0x41, ...encodeSignedLeb(spec.returns), 0x0b];
    return [body.length, ...body];
  });
  const code = section(10, [specs.length, ...bodies]);

  // [len = 9][cap = 9][zigzag(1) = 0x02]
  const imageResult = [0x09, 0, 0, 0, 0x09, 0, 0, 0, 0x02];
  const messageBytes = Array.from(new TextEncoder().encode(MESSAGE_TEXT));
  const totalLen = 12 + messageBytes.length;
  // [marker = -1][cap][total_len][utf8 message]
  const messageResult = [
    0xff, 0xff, 0xff, 0xff,
    totalLen, 0, 0, 0,
    totalLen, 0, 0, 0,
    ...messageBytes,
  ];
  const segment = (offset: number, bytes: number[]) => [
    0x00,
    0x41,
    ...encodeSignedLeb(offset),
    0x0b,
    ...encodeSignedLeb(bytes.length),
    ...bytes,
  ];
  const data = section(11, [
    0x02,
    ...segment(IMAGE_RESULT_PTR, imageResult),
    ...segment(MESSAGE_RESULT_PTR, messageResult),
  ]);

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...types,
    ...functions,
    ...memory,
    ...exports,
    ...code,
    ...data,
  ]);
}

const processedImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const stubCanvasModule: CanvasModule = {
  createCanvasImports: () => ({}),
  createHostImage: async () => ({ rid: 1, width: 2, height: 2 }),
  getHostImageData: (_store, rid) => (rid === 1 ? processedImageBytes : null),
};

const stubHttpBridge: HttpBridge = {
  request: () => ({ status: 0, headers: {}, body: "", bytes: null }),
};

const stubManifest: SourceManifest = {
  info: { id: "test.source", name: "Test Source", version: 1 },
};

function loadWasmSource(
  specs: WasmExportSpec[],
  options: Partial<AidokuRuntimeOptions> = {}
) {
  return createLoadSource(stubCanvasModule)(
    { wasmBytes: buildSourceWasm(specs), manifest: stubManifest },
    "test.source",
    { httpBridge: stubHttpBridge, ...options }
  );
}

const testManga = { sourceId: "test.source", id: "m1", key: "m1" };
const testChapter = { sourceId: "test.source", id: "c1", key: "c1", mangaId: "m1" };

describe("image processors", () => {
  it("reports a cover processor when the source exports process_cover_image", async () => {
    const source = await loadWasmSource([
      { name: "process_cover_image", arity: 1, returns: IMAGE_RESULT_PTR },
    ]);

    expect(source.hasCoverImageProcessor).toBe(true);
    expect(source.hasImageProcessor).toBe(false);
  });

  it("processes a cover image and returns the processed bytes", async () => {
    const source = await loadWasmSource([
      { name: "process_cover_image", arity: 1, returns: IMAGE_RESULT_PTR },
    ]);

    const processed = await source.processCoverImage(
      new Uint8Array([1, 2, 3]),
      "https://example.com/cover.jpg",
      { Referer: "https://example.com" },
      200,
      { "content-type": "image/jpeg" }
    );

    expect(processed).toEqual(processedImageBytes);
  });

  it("returns null and reports no cover processor when the export is missing", async () => {
    const source = await loadWasmSource([
      { name: "process_page_image", arity: 2, returns: IMAGE_RESULT_PTR },
    ]);

    expect(source.hasCoverImageProcessor).toBe(false);
    expect(source.hasImageProcessor).toBe(true);
    expect(
      await source.processCoverImage(
        new Uint8Array([1, 2, 3]),
        "https://example.com/cover.jpg",
        {},
        200,
        {}
      )
    ).toBeNull();
  });

  it("still processes page images with the page context", async () => {
    const source = await loadWasmSource([
      { name: "process_page_image", arity: 2, returns: IMAGE_RESULT_PTR },
    ]);

    const processed = await source.processPageImage(
      new Uint8Array([1, 2, 3]),
      { width: "800" },
      "https://example.com/page.jpg",
      {},
      200,
      {}
    );

    expect(processed).toEqual(processedImageBytes);
  });

  it("reports no processors for a source exporting neither", async () => {
    const source = await loadWasmSource([]);

    expect(source.hasImageProcessor).toBe(false);
    expect(source.hasCoverImageProcessor).toBe(false);
  });
});

describe("source error results", () => {
  it("rejects a failed search with the error code", async () => {
    const source = await loadWasmSource([
      { name: "get_search_manga_list", arity: 3, returns: -3 },
    ]);

    expect(() => source.getSearchMangaList("query", 1, [])).toThrow(AidokuResultError);
    try {
      source.getSearchMangaList("query", 1, []);
    } catch (e) {
      expect((e as AidokuResultError).code).toBe(-3);
      expect((e as AidokuResultError).message).toBe("Request error");
    }
  });

  it("rejects manga details with the message the source returned", async () => {
    const source = await loadWasmSource([
      { name: "get_manga_update", arity: 3, returns: MESSAGE_RESULT_PTR },
    ]);

    expect(() => source.getMangaDetails(testManga)).toThrow(MESSAGE_TEXT);
    try {
      source.getMangaDetails(testManga);
    } catch (e) {
      expect(e).toBeInstanceOf(AidokuResultError);
      expect((e as AidokuResultError).code).toBe(-1);
    }
  });

  it("rejects a chapter list with the message the source returned", async () => {
    const source = await loadWasmSource([
      { name: "get_manga_update", arity: 3, returns: MESSAGE_RESULT_PTR },
    ]);

    expect(() => source.getChapterList(testManga)).toThrow(MESSAGE_TEXT);
  });

  it("rejects a page list with the error code", async () => {
    const source = await loadWasmSource([
      { name: "get_page_list", arity: 2, returns: -2 },
    ]);

    try {
      source.getPageList(testManga, testChapter);
      throw new Error("expected a source error");
    } catch (e) {
      expect(e).toBeInstanceOf(AidokuResultError);
      expect((e as AidokuResultError).code).toBe(-2);
      expect((e as AidokuResultError).message).toBe("Unimplemented");
    }
  });

  it("rejects a listing with the error code", async () => {
    const source = await loadWasmSource([
      { name: "get_manga_list", arity: 2, returns: -3 },
    ]);

    expect(source.mode).toBe(RuntimeMode.AidokuRs);
    expect(() =>
      source.getMangaListForListing({ id: "popular", name: "Popular" }, 1)
    ).toThrow(AidokuResultError);
  });

  it("rejects a home layout with the message the source returned", async () => {
    const source = await loadWasmSource([
      { name: "get_home", arity: 0, returns: MESSAGE_RESULT_PTR },
    ]);

    expect(() => source.getHome()).toThrow(MESSAGE_TEXT);
  });

  it("keeps filters and listings lenient", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const source = await loadWasmSource([
        { name: "get_filters", arity: 0, returns: -3 },
        { name: "get_listings", arity: 0, returns: -3 },
      ]);

      expect(source.getFilters()).toEqual([]);
      expect(source.getListings()).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});

describe("default User-Agent", () => {
  const webViewUserAgent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

  it("reports the built-in default when the option is omitted", async () => {
    const source = await loadWasmSource([]);
    expect(source.defaultUserAgent).toBe(DEFAULT_USER_AGENT);
  });

  it("reports and uses a host-supplied default", async () => {
    const source = await loadWasmSource([], { defaultUserAgent: webViewUserAgent });

    expect(source.defaultUserAgent).toBe(webViewUserAgent);
    // Image requests are fetched by the host, so they carry the same UA as
    // the requests the source makes itself.
    expect(source.modifyImageRequest("https://example.com/p.jpg").headers["User-Agent"]).toBe(
      webViewUserAgent
    );
  });

  it("falls back to the built-in default for an invalid value", async () => {
    const source = await loadWasmSource([], { defaultUserAgent: "   " });

    expect(source.defaultUserAgent).toBe(DEFAULT_USER_AGENT);
    expect(source.modifyImageRequest("https://example.com/p.jpg").headers["User-Agent"]).toBe(
      DEFAULT_USER_AGENT
    );
  });
});
