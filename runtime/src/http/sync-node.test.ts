import { describe, expect, it } from "bun:test";
import { parseCurlOutput, parseEffectiveUrl } from "./sync-node";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("parseCurlOutput", () => {
  it("splits a single response into status, headers and body", () => {
    const parsed = parseCurlOutput(
      encode("HTTP/2 200\r\ncontent-type: text/html\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\n<html></html>")
    );
    expect(parsed.status).toBe(200);
    expect(parsed.headers).toEqual({ "content-type": "text/html", "set-cookie": "a=1, b=2" });
    expect(decode(parsed.bytes)).toBe("<html></html>");
  });

  it("uses the last header block after redirects", () => {
    const parsed = parseCurlOutput(
      encode(
        "HTTP/1.1 301 Moved Permanently\r\nlocation: https://example.com/b\r\n\r\n" +
          "HTTP/1.1 302 Found\r\nlocation: /c\r\n\r\n" +
          "HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}"
      )
    );
    expect(parsed.status).toBe(200);
    expect(parsed.headers).toEqual({ "content-type": "application/json" });
    expect(decode(parsed.bytes)).toBe("{\"ok\":true}");
  });

  it("skips interim 1xx responses", () => {
    const parsed = parseCurlOutput(
      encode("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nx-id: 7\r\n\r\ndone")
    );
    expect(parsed.status).toBe(201);
    expect(parsed.headers).toEqual({ "x-id": "7" });
    expect(decode(parsed.bytes)).toBe("done");
  });

  it("keeps an unfollowed redirect as the final response", () => {
    const parsed = parseCurlOutput(encode("HTTP/1.1 302 Found\r\nlocation: /x\r\n\r\nmoved"));
    expect(parsed.status).toBe(302);
    expect(decode(parsed.bytes)).toBe("moved");
  });

  it("does not treat a body starting with HTTP/ as headers after a 200", () => {
    const parsed = parseCurlOutput(encode("HTTP/1.1 200 OK\n\nHTTP/1.1 is a protocol\n\nmore"));
    expect(parsed.status).toBe(200);
    expect(decode(parsed.bytes)).toBe("HTTP/1.1 is a protocol\n\nmore");
  });

  it("treats output without headers as a body", () => {
    const parsed = parseCurlOutput(encode("plain"));
    expect(parsed.status).toBe(200);
    expect(parsed.headers).toEqual({});
    expect(decode(parsed.bytes)).toBe("plain");
  });
});

describe("parseEffectiveUrl", () => {
  it("reads the URL curl wrote after its marker", () => {
    expect(
      parseEffectiveUrl("curl: (60) warning\n__aidoku_effective_url__:https://example.com/final\n")
    ).toBe("https://example.com/final");
  });

  it("returns undefined without a marker or URL", () => {
    expect(parseEffectiveUrl("")).toBeUndefined();
    expect(parseEffectiveUrl("__aidoku_effective_url__:\n")).toBeUndefined();
  });
});
