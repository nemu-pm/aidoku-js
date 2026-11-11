import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import type { HttpBridge, HttpRequest, HttpResponse } from "../types";
import { BROWSER_USER_AGENT, CloudflareBlockedError, createNetImports } from "./net";

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

describe("net.send User-Agent", () => {
  let store: GlobalStore | null = null;

  /** Answers with a challenge for hosts in `challenging`, records each request. */
  function prepare(challenging: string[] = []) {
    store = new GlobalStore("multi.mangadex");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const sent: HttpRequest[] = [];
    const bridge: HttpBridge = {
      request: (req) => {
        sent.push({ ...req, headers: { ...req.headers } });
        const challenge = challenging.includes(new URL(req.url).host);
        return challenge
          ? { status: 403, headers: { server: "cloudflare" }, body: CHALLENGE_BODY, bytes: null }
          : { status: 200, headers: {}, body: "{}", bytes: null };
      },
    };
    const imports = createNetImports(store, bridge);
    const request = (url: string, headers: Record<string, string> = {}) => {
      const descriptor = imports.init(0);
      const req = store!.requests.get(descriptor)!;
      req.url = url;
      Object.assign(req.headers, headers);
      return descriptor;
    };
    const sendCatching = (descriptor: number) => {
      try {
        imports.send(descriptor);
      } catch (e) {
        return e as CloudflareBlockedError;
      }
      throw new Error("expected a Cloudflare challenge");
    };
    return { imports, request, sendCatching, sent };
  }

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("sends no default User-Agent", () => {
    const { imports, request, sent } = prepare();
    const descriptor = request("https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token");

    expect(imports.send(descriptor)).toBe(0);
    expect(sent[0].headers).toEqual({});
  });

  it("sends the source's User-Agent as set, in any casing", () => {
    const { imports, request, sent } = prepare();
    imports.send(request("https://api.mangadex.org/manga", { "User-Agent": "Aidoku" }));
    imports.send(request("https://picaapi.picacomic.com/", { "user-agent": "okhttp/3.8.1" }));

    expect(sent[0].headers).toEqual({ "User-Agent": "Aidoku" });
    expect(sent[1].headers).toEqual({ "user-agent": "okhttp/3.8.1" });
  });

  it("sends the browser User-Agent to a host once it challenges a request without one", () => {
    const { imports, request, sendCatching, sent } = prepare(["example.com"]);

    const cfError = sendCatching(request("https://example.com/manga/1"));
    expect(sent[0].headers).toEqual({});
    expect(cfError.challengeInfo).toEqual({
      url: "https://example.com/manga/1",
      status: 403,
      host: "example.com",
      userAgent: BROWSER_USER_AGENT,
    });

    // The retry after a solve presents the UA the clearance was issued for.
    sendCatching(request("https://example.com/manga/1"));
    expect(sent[1].headers).toEqual({ "User-Agent": BROWSER_USER_AGENT });

    // Other hosts are unaffected.
    imports.send(request("https://api.example.org/"));
    expect(sent[2].headers).toEqual({});
  });

  it("keeps the source's User-Agent on a challenged host", () => {
    const { request, sendCatching, sent } = prepare(["example.com"]);
    sendCatching(request("https://example.com/manga/1"));

    const cfError = sendCatching(request("https://example.com/manga/2", { "User-Agent": "Aidoku/1" }));
    expect(sent[1].headers).toEqual({ "User-Agent": "Aidoku/1" });
    expect(cfError.userAgent).toBe("Aidoku/1");
  });

  it("does not switch a host to the browser User-Agent after a challenge on a source-set UA", () => {
    const { request, sendCatching, sent } = prepare(["example.com"]);
    sendCatching(request("https://example.com/manga/1", { "User-Agent": "Aidoku/1" }));
    sendCatching(request("https://example.com/manga/2"));

    expect(sent[1].headers).toEqual({});
  });
});
