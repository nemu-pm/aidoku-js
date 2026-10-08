import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSyncXhrBridge } from "./sync-xhr";

const PROXY = "https://proxy.example/proxy?url=";
const proxyUrl = (url: string) => `${PROXY}${encodeURIComponent(url)}`;

interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** XMLHttpRequest.responseURL; defaults to the URL the request was opened with. */
  responseURL?: string;
}

let reply: FakeReply = {};
let opened: { method: string; url: string; headers: Record<string, string> } | null = null;

class FakeXMLHttpRequest {
  responseType = "";
  status = 0;
  response: ArrayBuffer | null = null;
  responseURL = "";
  private url = "";
  private requestHeaders: Record<string, string> = {};

  open(method: string, url: string) {
    this.url = url;
    opened = { method, url, headers: this.requestHeaders };
  }

  setRequestHeader(key: string, value: string) {
    this.requestHeaders[key] = value;
  }

  send() {
    this.status = reply.status ?? 200;
    this.response = new TextEncoder().encode(reply.body ?? "").buffer as ArrayBuffer;
    this.responseURL = reply.responseURL ?? this.url;
  }

  getAllResponseHeaders() {
    return Object.entries(reply.headers ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");
  }
}

const originalXhr = globalThis.XMLHttpRequest;

beforeEach(() => {
  reply = {};
  opened = null;
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXMLHttpRequest;
});

afterEach(() => {
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = originalXhr;
});

const get = (url: string) => ({ url, method: "GET", headers: { Referer: "https://rawfree.bid/" }, body: null });

describe("createSyncXhrBridge final URL", () => {
  it("takes a proxied response's final URL from X-Nemu-Final-Url", () => {
    reply = { headers: { "X-Nemu-Final-Url": "https://rawfree.llc/" }, body: "<html>" };
    const response = createSyncXhrBridge({ proxyUrl }).request(get("https://rawfree.bid/"));

    expect(opened?.url).toBe(proxyUrl("https://rawfree.bid/"));
    expect(opened?.headers).toEqual({ "x-proxy-Referer": "https://rawfree.bid/" });
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://rawfree.llc/");
  });

  it("never reports the proxy's own URL for a proxied response", () => {
    const response = createSyncXhrBridge({ proxyUrl }).request(get("https://rawfree.bid/"));
    expect(response.url).toBeUndefined();
  });

  it("uses responseURL for a direct request", () => {
    reply = { responseURL: "https://example.com/final" };
    const response = createSyncXhrBridge().request(get("https://example.com/start"));
    expect(opened?.url).toBe("https://example.com/start");
    expect(response.url).toBe("https://example.com/final");
  });

  it("prefers the header over responseURL for a direct request", () => {
    reply = {
      headers: { "x-nemu-final-url": "https://rawfree.llc/" },
      responseURL: "https://example.com/start",
    };
    const response = createSyncXhrBridge().request(get("https://example.com/start"));
    expect(response.url).toBe("https://rawfree.llc/");
  });
});
