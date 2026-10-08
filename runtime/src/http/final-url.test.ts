import { describe, expect, it } from "bun:test";
import { FINAL_URL_HEADER, resolveFinalUrl } from "./final-url";

describe("resolveFinalUrl", () => {
  it("prefers the proxy's X-Nemu-Final-Url header over the transport URL", () => {
    expect(
      resolveFinalUrl({ [FINAL_URL_HEADER]: "https://rawfree.llc/" }, "https://rawfree.bid/")
    ).toBe("https://rawfree.llc/");
  });

  it("matches the header name case-insensitively in a record", () => {
    expect(resolveFinalUrl({ "X-Nemu-Final-Url": "https://rawfree.llc/manga/1" })).toBe(
      "https://rawfree.llc/manga/1"
    );
  });

  it("reads a fetch Headers object", () => {
    const headers = new Headers({ "X-Nemu-Final-Url": "https://rawfree.llc/" });
    expect(resolveFinalUrl(headers)).toBe("https://rawfree.llc/");
  });

  it("falls back to the transport URL without a header", () => {
    expect(resolveFinalUrl({}, "https://example.com/final")).toBe("https://example.com/final");
    expect(resolveFinalUrl(new Headers(), "https://example.com/final")).toBe(
      "https://example.com/final"
    );
  });

  it("ignores a header that is not an absolute http(s) URL", () => {
    expect(resolveFinalUrl({ [FINAL_URL_HEADER]: "/relative" }, "https://a.example/")).toBe(
      "https://a.example/"
    );
    expect(resolveFinalUrl({ [FINAL_URL_HEADER]: "javascript:alert(1)" })).toBeUndefined();
    expect(resolveFinalUrl({ [FINAL_URL_HEADER]: "" })).toBeUndefined();
  });

  it("is undefined when nothing is known, so callers use the request URL", () => {
    expect(resolveFinalUrl({})).toBeUndefined();
    expect(resolveFinalUrl({}, "")).toBeUndefined();
    expect(resolveFinalUrl({}, null)).toBeUndefined();
  });
});
