import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  createLoadSource,
  findManifestSelect,
  resolveLegacySelectIndex,
  type CanvasModule,
} from "./runtime";
import { GlobalStore } from "./global-store";
import { concatBytes, encodeString, encodeVecString } from "./postcard";
import { buildWasm, framedResult, op, type WasmFunctionSpec } from "./testing/wasm-builder";
import {
  FilterType,
  type FilterInfo,
  type FilterValue,
  type HttpBridge,
  type SourceManifest,
} from "./types";

const select = (name: string, value: FilterValue["value"]): FilterValue => ({
  type: FilterType.Select,
  name,
  value,
});

describe("resolveLegacySelectIndex", () => {
  const sort = { options: ["Popular", "Latest", "Rating"], ids: ["popular", "latest", "rating"] };

  it("keeps integer indices", () => {
    expect(resolveLegacySelectIndex(select("Sort", 2), sort)).toBe(2);
    expect(resolveLegacySelectIndex(select("Unknown", 5), undefined)).toBe(5);
  });

  it("maps ids, then option labels, to their index", () => {
    expect(resolveLegacySelectIndex(select("Sort", "latest"), sort)).toBe(1);
    expect(resolveLegacySelectIndex(select("Sort", "Rating"), sort)).toBe(2);
  });

  it("parses numeric strings when nothing matches", () => {
    expect(resolveLegacySelectIndex(select("Sort", "1"), sort)).toBe(1);
    expect(resolveLegacySelectIndex(select("Unknown", "3"), undefined)).toBe(3);
  });

  it("falls back to the first option", () => {
    expect(resolveLegacySelectIndex(select("Sort", "nope"), sort)).toBe(0);
    expect(resolveLegacySelectIndex(select("Sort", 1.5), sort)).toBe(0);
    expect(resolveLegacySelectIndex(select("Sort", true), sort)).toBe(0);
    expect(resolveLegacySelectIndex(select("Sort", undefined), sort)).toBe(0);
  });
});

describe("findManifestSelect", () => {
  const filters: FilterInfo[] = [
    { type: "title" },
    { type: "select", name: "Sort", options: ["Popular", "Latest"] },
    {
      type: "group",
      title: "More",
      filters: [{ type: "select", title: "Status", id: "status", options: ["Any", "Done"] }],
    },
    { type: FilterType.Select as unknown as string, title: "Numeric", options: ["a", "b"] },
  ];

  it("matches by name, title or id, including inside groups", () => {
    expect(findManifestSelect(filters, "Sort")?.options).toEqual(["Popular", "Latest"]);
    expect(findManifestSelect(filters, "Status")?.options).toEqual(["Any", "Done"]);
    expect(findManifestSelect(filters, "status")?.options).toEqual(["Any", "Done"]);
    expect(findManifestSelect(filters, "Numeric")?.options).toEqual(["a", "b"]);
    expect(findManifestSelect(filters, "Missing")).toBeUndefined();
    expect(findManifestSelect(undefined, "Sort")).toBeUndefined();
  });
});

describe("legacy search select filters", () => {
  const spies: { mockRestore(): void }[] = [];

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  const stubCanvasModule: CanvasModule = {
    createCanvasImports: () => ({}),
    createHostImage: async () => null,
    getHostImageData: () => null,
  };
  const stubHttpBridge: HttpBridge = {
    request: () => ({ status: 200, headers: {}, body: "", bytes: null }),
  };

  /** A get_filters result declaring one select, as aidoku-rs encodes it. */
  function selectFilterList(name: string, options: string[]): number[] {
    const filter = concatBytes([
      new Uint8Array([2]), // Select variant
      encodeString(name),
      encodeVecString(options),
      new Uint8Array([0]), // default index
    ]);
    return framedResult([1, ...filter]);
  }

  /** Load a legacy source; `extra` adds exports such as get_filters. */
  async function loadLegacy(filters: FilterInfo[] | undefined, extra: WasmFunctionSpec[] = []) {
    const manifest: SourceManifest = {
      info: { id: "test.legacy", name: "Legacy Source", version: 1 },
      filters,
    };
    return createLoadSource(stubCanvasModule)(
      {
        wasmBytes: buildWasm({
          functions: [
            { name: "get_manga_details", params: 1, results: 1, body: op.i32Const(-1) },
            { name: "get_manga_list", params: 2, results: 1, body: op.i32Const(-1) },
            ...extra,
          ],
          data: [{ offset: 64, bytes: selectFilterList("Order", ["Hot", "New", "Top"]) }],
        }),
        manifest,
      },
      "test.legacy",
      { httpBridge: stubHttpBridge }
    );
  }

  /** Capture the filter objects the next search stores for the source. */
  function captureSwiftFilters() {
    const stored: unknown[] = [];
    const original = GlobalStore.prototype.storeStdValue;
    const spy = spyOn(GlobalStore.prototype, "storeStdValue").mockImplementation(function (
      this: GlobalStore,
      value: unknown
    ) {
      stored.push(value);
      return original.call(this, value);
    });
    spies.push(spy);
    return () => (stored[0] as { name: string; value: unknown }[]).map((f) => [f.name, f.value]);
  }

  it("resolves selects declared in filters.json", async () => {
    const source = await loadLegacy([
      { type: "select", name: "Sort", options: ["Popular", "Latest"] },
      {
        type: "group",
        title: "More",
        filters: [{ type: "select", title: "Status", options: ["Any", "Ongoing"], ids: ["", "ongoing"] }],
      },
    ]);
    const swiftFilters = captureSwiftFilters();

    const result = source.getSearchMangaList(null, 1, [
      select("Sort", "Latest"),
      select("Status", "ongoing"),
      select("Page", "4"),
    ]);

    expect(result).toEqual({ entries: [], hasNextPage: false });
    expect(swiftFilters()).toEqual([
      ["Sort", 1],
      ["Status", 1],
      ["Page", 4],
    ]);
  });

  it("falls back to the filters the source reports through get_filters", async () => {
    const source = await loadLegacy(undefined, [
      { name: "get_filters", params: 0, results: 1, body: op.i32Const(64) },
    ]);
    const swiftFilters = captureSwiftFilters();

    source.getSearchMangaList(null, 1, [select("Order", "New")]);

    expect(swiftFilters()).toEqual([["Order", 1]]);
  });

  it("works when the method is called detached from the source", async () => {
    const source = await loadLegacy([
      { type: "select", name: "Sort", options: ["Popular", "Latest"] },
    ]);
    const swiftFilters = captureSwiftFilters();
    const search = source.getSearchMangaList;

    expect(() => search(null, 1, [select("Sort", "Latest")])).not.toThrow();
    expect(swiftFilters()).toEqual([["Sort", 1]]);
  });
});
