import { describe, expect, it } from "bun:test";
import {
  createSabBuffer,
  createSabMainThreadHandler,
  createSabWorkerBridge,
  type SabHttpRequest,
} from "./sync-sab";

const BUFFER_SIZE = 64 * 1024;

/** A Response whose `url` and `redirected` are set as a real fetch would. */
function fetchedResponse(
  body: string,
  init: ResponseInit & { url?: string; redirected?: boolean } = {}
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: init.url ?? "" });
  Object.defineProperty(response, "redirected", { value: init.redirected ?? false });
  return response;
}

/**
 * Send one request through the worker bridge, answered by the main-thread
 * handler. The handler is async, so it fills a staging buffer first; the
 * worker's postMessage then copies that in synchronously, before it waits.
 */
async function roundTrip(response: Response, url = "https://rawfree.bid/") {
  const staging = createSabBuffer(BUFFER_SIZE);
  const seen: { url: string; init: RequestInit }[] = [];
  const handler = createSabMainThreadHandler(async (target, init) => {
    seen.push({ url: target, init });
    return response;
  }, staging);
  const request = { url, method: "GET", headers: { Accept: "*/*" }, body: null };
  await handler({ type: "HTTP_REQUEST", id: 1, request });

  const shared = createSabBuffer(BUFFER_SIZE);
  const bridge = createSabWorkerBridge((msg: SabHttpRequest) => {
    expect(msg.request).toEqual(request);
    new Uint8Array(shared).set(new Uint8Array(staging));
  }, shared);
  return { response: bridge.request(request), seen };
}

describe("SAB bridge final URL", () => {
  it("carries X-Nemu-Final-Url from the main thread to the worker", async () => {
    const { response, seen } = await roundTrip(
      fetchedResponse("<html>", {
        headers: { "X-Nemu-Final-Url": "https://rawfree.llc/", "content-type": "text/html" },
        url: "https://proxy.example/proxy?url=https%3A%2F%2Frawfree.bid%2F",
      })
    );
    expect(seen[0].url).toBe("https://rawfree.bid/");
    expect(response.status).toBe(200);
    expect(response.body).toBe("<html>");
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.url).toBe("https://rawfree.llc/");
  });

  it("uses Response.url when the fetch was redirected", async () => {
    const { response } = await roundTrip(
      fetchedResponse("ok", { url: "https://example.com/final", redirected: true }),
      "https://example.com/start"
    );
    expect(response.url).toBe("https://example.com/final");
  });

  it("ignores an unredirected Response.url, which may be a proxy's", async () => {
    const { response } = await roundTrip(
      fetchedResponse("ok", { url: "https://proxy.example/proxy?url=x" })
    );
    expect(response.url).toBeUndefined();
  });
});
