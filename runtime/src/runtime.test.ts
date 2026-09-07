import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildLegacyListingValue,
  callLegacyMangaListing,
  decodeLegacyMangaPageResult,
  detectListingProvider,
} from "./runtime";
import { GlobalStore } from "./global-store";
import { CloudflareBlockedError } from "./imports/net";
import { RuntimeMode } from "./result-decoder";
import { ListingKind } from "./types";

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
