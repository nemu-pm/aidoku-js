import { describe, expect, it } from "bun:test";
import type { AidokuSource } from "../runtime";
import type { HomeLayout } from "../types";
import { CloudflareBlockedError } from "../imports/net";
import type { CloudflareChallengeInfo } from "../cloudflare/detect";
import { createAsyncWrapper, createCfRetry } from "./common";

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
    hasCoverImageProcessor: true,
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
    processCoverImage: async (imageData) => imageData,
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

describe("createAsyncWrapper cover image processing", () => {
  it("exposes the cover processor flag and forwards the response", async () => {
    const source = createSource((url) => ({ url, headers: {} }));
    const wrapper = createAsyncWrapper(source, async (fn) => fn());

    expect(await wrapper.hasCoverImageProcessor()).toBe(true);
    expect(
      await wrapper.processCoverImage(
        new Uint8Array([1, 2, 3]),
        "https://example.com/cover.jpg",
        {},
        200,
        {}
      )
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("createCfRetry", () => {
  const challenge = (url = "https://example.com/manga/1") =>
    new CloudflareBlockedError(url, 403, { userAgent: "Aidoku/1" });

  /** Fails the first `failures` calls with a challenge, then returns "ok". */
  function flakyRequest(failures: number, url?: string) {
    let calls = 0;
    return {
      calls: () => calls,
      fn: () => {
        calls++;
        if (calls <= failures) throw challenge(url);
        return "ok";
      },
    };
  }

  it("solves the challenge once for concurrent calls to the same host", async () => {
    const solverCalls: CloudflareChallengeInfo[] = [];
    const solver = async (info: CloudflareChallengeInfo) => {
      solverCalls.push(info);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return true;
    };
    const cfRetry = createCfRetry(undefined, solver);
    const first = flakyRequest(1);
    const second = flakyRequest(1);

    const results = await Promise.all([cfRetry(first.fn), cfRetry(second.fn)]);

    expect(results).toEqual(["ok", "ok"]);
    expect(solverCalls).toHaveLength(1);
    expect(solverCalls[0]).toEqual({
      url: "https://example.com/manga/1",
      status: 403,
      host: "example.com",
      userAgent: "Aidoku/1",
    });
    expect(first.calls()).toBe(2);
    expect(second.calls()).toBe(2);
  });

  it("solves separately for different hosts", async () => {
    const hosts: string[] = [];
    const solver = async (info: CloudflareChallengeInfo) => {
      hosts.push(info.host);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return true;
    };
    const cfRetry = createCfRetry(undefined, solver);
    const a = flakyRequest(1, "https://a.example.com/1");
    const b = flakyRequest(1, "https://b.example.com/1");

    await Promise.all([cfRetry(a.fn), cfRetry(b.fn)]);

    expect(hosts.sort()).toEqual(["a.example.com", "b.example.com"]);
  });

  it("survives a second challenge issued right after the first clearance", async () => {
    let solverCalls = 0;
    const cfRetry = createCfRetry(undefined, async () => {
      solverCalls++;
      return true;
    });
    const request = flakyRequest(2);

    expect(await cfRetry(request.fn)).toBe("ok");
    expect(solverCalls).toBe(2);
    expect(request.calls()).toBe(3);
  });

  it("rethrows the original challenge after the last round fails", async () => {
    let solverCalls = 0;
    const cfRetry = createCfRetry(undefined, async () => {
      solverCalls++;
      return true;
    });
    const first = challenge();
    let calls = 0;
    const fn = () => {
      calls++;
      throw calls === 1 ? first : challenge();
    };

    await expect(cfRetry(fn)).rejects.toBe(first);

    expect(solverCalls).toBe(2);
    expect(calls).toBe(3);
  });

  it("rethrows when the solver declines", async () => {
    let solverCalls = 0;
    const cfRetry = createCfRetry(undefined, async () => {
      solverCalls++;
      return false;
    });
    const request = flakyRequest(1);

    await expect(cfRetry(request.fn)).rejects.toBeInstanceOf(CloudflareBlockedError);
    expect(solverCalls).toBe(1);
    expect(request.calls()).toBe(1);
  });

  it("rethrows a solver failure as a declined challenge", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const cfRetry = createCfRetry(undefined, async () => {
        throw new Error("solver crashed");
      });
      const request = flakyRequest(1);

      await expect(cfRetry(request.fn)).rejects.toBeInstanceOf(CloudflareBlockedError);
      expect(request.calls()).toBe(1);
    } finally {
      console.error = originalError;
    }
  });

  it("rethrows immediately when no solver and no agent are configured", async () => {
    const cfRetry = createCfRetry();
    const request = flakyRequest(1);

    await expect(cfRetry(request.fn)).rejects.toBeInstanceOf(CloudflareBlockedError);
    expect(request.calls()).toBe(1);
  });

  it("passes other errors straight through", async () => {
    let solverCalls = 0;
    const cfRetry = createCfRetry(undefined, async () => {
      solverCalls++;
      return true;
    });

    await expect(
      cfRetry(() => {
        throw new Error("wasm trap");
      })
    ).rejects.toThrow("wasm trap");
    expect(solverCalls).toBe(0);
  });

  it("retries async rejections too", async () => {
    const cfRetry = createCfRetry(undefined, async () => true);
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw challenge();
      return "ok";
    };

    expect(await cfRetry(fn)).toBe("ok");
    expect(calls).toBe(2);
  });
});
