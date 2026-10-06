import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import type { HttpBridge, HttpResponse } from "../types";
import { CloudflareBlockedError, createNetImports } from "./net";

const CHALLENGE_BODY = "<html><head><title>Just a moment...</title></head></html>";

function bridgeReturning(response: Partial<HttpResponse>): HttpBridge {
  return {
    request: () => ({
      status: 200,
      headers: {},
      body: "",
      bytes: null,
      ...response,
    }),
  };
}

describe("net.send Cloudflare handling", () => {
  let store: GlobalStore | null = null;

  function prepare(response: Partial<HttpResponse>) {
    store = new GlobalStore("ja.rawkuma");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createNetImports(store, bridgeReturning(response));
    const descriptor = imports.init(0);
    const request = store.requests.get(descriptor)!;
    request.url = "https://example.com/manga/1";
    return { imports, descriptor, request };
  }

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("raises a challenge error carrying the host and User-Agent", () => {
    const { imports, descriptor, request } = prepare({
      status: 403,
      headers: { server: "cloudflare" },
      body: CHALLENGE_BODY,
    });
    request.headers["User-Agent"] = "Aidoku/1";

    try {
      imports.send(descriptor);
      throw new Error("expected a Cloudflare challenge");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudflareBlockedError);
      const cfError = e as CloudflareBlockedError;
      expect(cfError.url).toBe("https://example.com/manga/1");
      expect(cfError.status).toBe(403);
      expect(cfError.host).toBe("example.com");
      expect(cfError.userAgent).toBe("Aidoku/1");
      expect(cfError.challengeInfo).toEqual({
        url: "https://example.com/manga/1",
        status: 403,
        host: "example.com",
        userAgent: "Aidoku/1",
      });
    }
  });

  it("passes an ordinary 403 from a Cloudflare-fronted site through to the source", () => {
    const { imports, descriptor } = prepare({
      status: 403,
      headers: { server: "cloudflare" },
      body: "<html><body>Forbidden</body></html>",
    });

    expect(imports.send(descriptor)).toBe(0);
    expect(imports.get_status_code(descriptor)).toBe(403);
  });

  it("passes a rate limit through to the source", () => {
    const { imports, descriptor } = prepare({
      status: 429,
      headers: { server: "cloudflare", "retry-after": "30" },
      body: "rate limited",
    });

    expect(imports.send(descriptor)).toBe(0);
    expect(imports.get_status_code(descriptor)).toBe(429);
  });
});

describe("net.get_url", () => {
  let store: GlobalStore | null = null;

  function prepare(
    response: Partial<HttpResponse>,
    options: { legacy?: boolean; throws?: boolean } = {}
  ) {
    store = new GlobalStore("ja.rawfree");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const bridge: HttpBridge = options.throws
      ? { request: () => { throw new Error("offline"); } }
      : bridgeReturning(response);
    const imports = createNetImports(store, bridge, {
      isLegacyAbi: () => options.legacy ?? false,
    });
    const descriptor = imports.init(0);
    store.requests.get(descriptor)!.url = "https://example.com/start";
    return { imports, descriptor, store };
  }

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("returns the final URL the bridge reports after redirects", () => {
    const { imports, descriptor, store } = prepare({ url: "https://example.com/final" });
    expect(imports.send(descriptor)).toBe(0);

    const rid = imports.get_url(descriptor);
    expect(rid).toBeGreaterThanOrEqual(0);
    expect(store.readStdValue(rid)).toBe("https://example.com/final");
  });

  it("falls back to the request URL when the bridge reports none", () => {
    const { imports, descriptor, store } = prepare({});
    imports.send(descriptor);

    expect(store.readStdValue(imports.get_url(descriptor))).toBe("https://example.com/start");
  });

  it("reports a missing response before sending and after a failed send", () => {
    const { imports, descriptor } = prepare({}, { throws: true });
    expect(imports.get_url(descriptor)).toBe(-8);

    expect(imports.send(descriptor)).toBe(-10);
    expect(imports.get_url(descriptor)).toBe(-8);
  });

  it("rejects unknown descriptors", () => {
    const { imports } = prepare({});
    expect(imports.get_url(-1)).toBe(-1);
    expect(imports.get_url(9999)).toBe(-1);
  });

  it("returns the request URL for legacy sources, before or after sending", () => {
    const { imports, descriptor, store } = prepare(
      { url: "https://example.com/final" },
      { legacy: true }
    );
    expect(store.readStdValue(imports.get_url(descriptor))).toBe("https://example.com/start");

    imports.send(descriptor);
    expect(store.readStdValue(imports.get_url(descriptor))).toBe("https://example.com/start");
  });

  it("returns an error for a legacy request without a URL", () => {
    const { imports, store } = prepare({}, { legacy: true });
    const bare = imports.init(0);
    expect(store.requests.get(bare)!.url).toBeUndefined();
    expect(imports.get_url(bare)).toBe(-1);
  });
});
