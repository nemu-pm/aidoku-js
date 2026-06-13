import { describe, expect, it } from "bun:test";
import type { AidokuSource } from "../runtime";
import type { HomeLayout } from "../types";
import { createAsyncWrapper } from "./common";

function createSource(
  modifyImageRequest: AidokuSource["modifyImageRequest"]
): AidokuSource {
  return {
    id: "test.source",
    manifest: {
      info: {
        id: "test.source",
        name: "Test Source",
        version: 1,
      },
    },
    settingsJson: undefined,
    mode: "aidoku-rs",
    hasImageProcessor: false,
    hasImageRequestProvider: true,
    hasHome: false,
    hasListingProvider: false,
    hasDynamicListings: false,
    handlesBasicLogin: false,
    handlesWebLogin: false,
    initialize() {},
    getSearchMangaList: () => ({ entries: [], hasNextPage: false }),
    getMangaDetails: (manga) => manga,
    getChapterList: () => [],
    getPageList: () => [],
    getFilters: () => [],
    getMangaListForListing: () => ({ entries: [], hasNextPage: false }),
    getHome: () => null,
    getHomeWithPartials: (_onPartial: (layout: HomeLayout) => void) => null,
    getListings: () => [],
    modifyImageRequest,
    processPageImage: async () => null,
  };
}

describe("createAsyncWrapper", () => {
  it("passes page context to modifyImageRequest", async () => {
    const context = { width: "800", height: "1200" };
    let capturedContext: Record<string, string> | null | undefined;
    const source = createSource((url, imageContext) => {
      capturedContext = imageContext;
      return { url, headers: { Referer: "https://example.com/manga" } };
    });

    const wrapper = createAsyncWrapper(source, async (fn) => fn());

    await wrapper.modifyImageRequest("https://example.com/page.jpg", context);

    expect(capturedContext).toEqual(context);
  });
});
