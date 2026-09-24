import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createLoadSource, resolveLegacySelectIndex, type CanvasModule } from "./runtime";
import { GlobalStore } from "./global-store";
import { buildWasm, op } from "./testing/wasm-builder";
import { FilterType, type Filter, type FilterValue, type HttpBridge, type SourceManifest } from "./types";

const sortBy: Filter = {
  type: FilterType.Select,
  name: "Sort",
  options: ["Popular", "Latest", "Rating"],
  ids: ["popular", "latest", "rating"],
  default: 0,
};

const status: Filter = {
  type: FilterType.Select,
  name: "Status",
  options: ["Any", "Ongoing", "Completed"],
  default: 0,
};

const definitions: Filter[] = [
  sortBy,
  { type: FilterType.Group, name: "More", filters: [status] },
];

const select = (name: string, value: FilterValue["value"]): FilterValue => ({
  type: FilterType.Select,
  name,
  value,
});

describe("resolveLegacySelectIndex", () => {
  it("keeps integer indices", () => {
    expect(resolveLegacySelectIndex(select("Sort", 2), definitions)).toBe(2);
    expect(resolveLegacySelectIndex(select("Unknown", 5), definitions)).toBe(5);
  });

  it("maps ids, then option labels, to their index", () => {
    expect(resolveLegacySelectIndex(select("Sort", "latest"), definitions)).toBe(1);
    expect(resolveLegacySelectIndex(select("Sort", "Rating"), definitions)).toBe(2);
  });

  it("finds definitions nested in groups", () => {
    expect(resolveLegacySelectIndex(select("Status", "Completed"), definitions)).toBe(2);
  });

  it("parses numeric strings when nothing matches", () => {
    expect(resolveLegacySelectIndex(select("Sort", "1"), definitions)).toBe(1);
    expect(resolveLegacySelectIndex(select("Unknown", "3"), [])).toBe(3);
  });

  it("falls back to the first option", () => {
    expect(resolveLegacySelectIndex(select("Sort", "nope"), definitions)).toBe(0);
    expect(resolveLegacySelectIndex(select("Sort", 1.5), definitions)).toBe(0);
    expect(resolveLegacySelectIndex(select("Sort", true), definitions)).toBe(0);
    expect(resolveLegacySelectIndex(select("Sort", undefined), definitions)).toBe(0);
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
  const manifest: SourceManifest = {
    info: { id: "test.legacy", name: "Legacy Source", version: 1 },
  };

  /** Load a legacy source and capture the filter objects search hands it. */
  async function searchWith(filters: FilterValue[], sourceDefinitions: Filter[]) {
    const source = await createLoadSource(stubCanvasModule)(
      {
        wasmBytes: buildWasm({
          functions: [
            { name: "get_manga_details", params: 1, results: 1, body: op.i32Const(-1) },
            { name: "get_manga_list", params: 2, results: 1, body: op.i32Const(-1) },
          ],
        }),
        manifest,
      },
      "test.legacy",
      { httpBridge: stubHttpBridge }
    );

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

    const result = source.getSearchMangaList.call(
      { ...source, getFilters: () => sourceDefinitions },
      null,
      1,
      filters
    );
    return { result, swiftFilters: stored[0] as { name: string; value: unknown }[] };
  }

  it("sends select values to the source as option indices", async () => {
    const { result, swiftFilters } = await searchWith(
      [select("Sort", "latest"), select("Status", "Completed"), select("Page", "4")],
      definitions
    );

    expect(result).toEqual({ entries: [], hasNextPage: false });
    expect(swiftFilters.map((f) => [f.name, f.value])).toEqual([
      ["Sort", 1],
      ["Status", 2],
      ["Page", 4],
    ]);
  });
});
