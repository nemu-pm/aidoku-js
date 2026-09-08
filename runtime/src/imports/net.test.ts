import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import type { HttpBridge, HttpResponse } from "../types";
import {
  CloudflareBlockedError,
  DEFAULT_USER_AGENT,
  createNetImports,
  type NetImportsOptions,
} from "./net";

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

describe("net default User-Agent", () => {
  let store: GlobalStore | null = null;
  let sentHeaders: Record<string, string> | null = null;

  /** Records the headers the bridge is asked to send. */
  function recordingBridge(): HttpBridge {
    return {
      request: (req) => {
        sentHeaders = { ...req.headers };
        return { status: 200, headers: {}, body: "", bytes: null };
      },
    };
  }

  function prepare(options?: NetImportsOptions) {
    store = new GlobalStore("ja.rawkuma");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createNetImports(store, recordingBridge(), options);
    const descriptor = imports.init(0);
    const request = store.requests.get(descriptor)!;
    request.url = "https://example.com/manga/1";
    return { imports, descriptor, request };
  }

  /** Set a header through the WASM ABI, which reads key and value from memory. */
  function setHeader(
    imports: ReturnType<typeof createNetImports>,
    descriptor: number,
    key: string,
    value: string
  ): number {
    const keyPtr = 1024;
    const valuePtr = 2048;
    store!.writeString(key, keyPtr);
    store!.writeString(value, valuePtr);
    return imports.set_header(
      descriptor,
      keyPtr,
      new TextEncoder().encode(key).length,
      valuePtr,
      new TextEncoder().encode(value).length
    );
  }

  afterEach(() => {
    store?.destroy();
    store = null;
    sentHeaders = null;
  });

  it("stamps the built-in default when no option is given", () => {
    const { request } = prepare();
    expect(request.headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
  });

  it("stamps a host-supplied User-Agent on new requests", () => {
    const webViewUserAgent =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    const { imports, descriptor, request } = prepare({ defaultUserAgent: webViewUserAgent });

    expect(request.headers["User-Agent"]).toBe(webViewUserAgent);
    expect(imports.send(descriptor)).toBe(0);
    expect(sentHeaders?.["User-Agent"]).toBe(webViewUserAgent);
  });

  it("trims a host-supplied User-Agent", () => {
    const { request } = prepare({ defaultUserAgent: "  Nemu/1.0  " });
    expect(request.headers["User-Agent"]).toBe("Nemu/1.0");
  });

  it("falls back to the built-in default for invalid values", () => {
    const invalid: (string | undefined)[] = [
      undefined,
      "",
      "   ",
      "Nemu/1.0\r\nX-Injected: 1",
      "Nemu/1.0\u007f",
      "U".repeat(513),
    ];

    for (const defaultUserAgent of invalid) {
      const { request } = prepare({ defaultUserAgent });
      expect(request.headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
      store?.destroy();
      store = null;
    }
  });

  it("accepts a User-Agent at the length limit", () => {
    const atLimit = "U".repeat(512);
    const { request } = prepare({ defaultUserAgent: atLimit });
    expect(request.headers["User-Agent"]).toBe(atLimit);
  });

  it("lets a source-set User-Agent win over the default", () => {
    const { imports, descriptor } = prepare({ defaultUserAgent: "Nemu/1.0" });

    expect(setHeader(imports, descriptor, "User-Agent", "SourceAgent/2")).toBe(0);
    expect(imports.send(descriptor)).toBe(0);
    expect(sentHeaders?.["User-Agent"]).toBe("SourceAgent/2");
  });
});
