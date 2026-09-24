import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { loadSource } from "./index.node";
import { GlobalStore } from "../global-store";
import { CloudflareBlockedError } from "../imports/net";
import { encodeString } from "../postcard";
import { buildWasm, framedResult, op } from "../testing/wasm-builder";
import type { SourceManifest } from "../types";

const KEY = "oauth_token";
const KEY_PTR = 16;
const VALUE_PTR = 64;
const STRING_KIND = 4;

const manifest: SourceManifest = {
  info: { id: "test.writer", name: "Writer", version: 1 },
};

/** A source whose `start` stores `token` under KEY via defaults.set. */
function writerSource(token: string) {
  const wasmBytes = buildWasm({
    imports: [{ module: "defaults", name: "set", params: 4, results: 1 }],
    functions: [
      {
        name: "start",
        params: 0,
        results: 0,
        body: [
          ...op.i32Const(KEY_PTR),
          ...op.i32Const(KEY.length),
          ...op.i32Const(STRING_KIND),
          ...op.i32Const(VALUE_PTR),
          ...op.call(0),
          ...op.drop(),
        ],
      },
    ],
    data: [
      { offset: KEY_PTR, bytes: new TextEncoder().encode(KEY) },
      { offset: VALUE_PTR, bytes: framedResult(encodeString(token)) },
    ],
  });
  return { wasmBytes, manifest };
}

describe("node loadSource settings write-back", () => {
  it("hands settings the source writes to the host setter", async () => {
    const writes: [string, unknown][] = [];
    await loadSource(writerSource("token-123"), "test.writer", {
      settings: {
        get: () => ({}),
        set: (key, value) => writes.push([key, value]),
      },
    });

    expect(writes).toEqual([[KEY, "token-123"]]);
  });

  it("loads without a host setter", async () => {
    const source = await loadSource(writerSource("token-123"), "test.writer", {
      settings: { get: () => ({}) },
    });
    expect(source.id).toBe("test.writer");
  });
});

/**
 * The node runtime fetches through curl in a child process, so the challenge
 * server runs in its own process. It answers the first /manga request with a
 * Cloudflare challenge and later ones with 200; /count reports and /reset
 * clears the number of /manga requests.
 */
const CHALLENGE_SERVER = `
let count = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/count") return new Response(String(count));
    if (path === "/reset") { count = 0; return new Response("ok"); }
    count++;
    if (count === 1 || process.env.ALWAYS_CHALLENGE) {
      return new Response("<html><head><title>Just a moment...</title></head></html>", {
        status: 403,
        headers: { server: "cloudflare", "content-type": "text/html" },
      });
    }
    return new Response("ok");
  },
});
console.log(server.port);
`;

async function startChallengeServer(env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "-e", CHALLENGE_SERVER], {
    stdout: "pipe",
    env: { ...process.env, ...env },
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const port = Number(new TextDecoder().decode(value).trim());
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/** A source whose start() requests `url`. */
function fetchingSource(url: string) {
  const URL_PTR = 64;
  const rid = 0;
  const wasmBytes = buildWasm({
    imports: [
      { module: "net", name: "init", params: 1, results: 1 },
      { module: "net", name: "set_url", params: 3, results: 1 },
      { module: "net", name: "send", params: 1, results: 1 },
    ],
    functions: [
      {
        name: "start",
        params: 0,
        results: 0,
        locals: 1,
        body: [
          ...op.i32Const(0),
          ...op.call(0),
          ...op.localSet(rid),
          ...op.localGet(rid),
          ...op.i32Const(URL_PTR),
          ...op.i32Const(url.length),
          ...op.call(1),
          ...op.drop(),
          ...op.localGet(rid),
          ...op.call(2),
          ...op.drop(),
        ],
      },
    ],
    data: [{ offset: URL_PTR, bytes: new TextEncoder().encode(url) }],
  });
  return { wasmBytes, manifest };
}

describe("node loadSource initialization", () => {
  let server: Awaited<ReturnType<typeof startChallengeServer>>;
  let blocking: Awaited<ReturnType<typeof startChallengeServer>>;
  const originalLog = console.log;

  beforeAll(async () => {
    console.log = () => {};
    server = await startChallengeServer();
    blocking = await startChallengeServer({ ALWAYS_CHALLENGE: "1" });
  });

  afterAll(() => {
    server?.stop();
    blocking?.stop();
    console.log = originalLog;
  });

  it("retries start() after a Cloudflare challenge is solved", async () => {
    await fetch(`${server.base}/reset`);
    const solved: string[] = [];

    const source = await loadSource(fetchingSource(`${server.base}/manga`), "test.writer", {
      cloudflareSolver: async (info) => {
        solved.push(info.url);
        return true;
      },
    });

    expect(solved).toEqual([`${server.base}/manga`]);
    expect(await (await fetch(`${server.base}/count`)).text()).toBe("2");
    source.dispose();
  });

  it("rejects with the challenge and releases the source when it is not solved", async () => {
    const destroy = spyOn(GlobalStore.prototype, "destroy");
    try {
      await expect(
        loadSource(fetchingSource(`${blocking.base}/manga`), "test.writer")
      ).rejects.toBeInstanceOf(CloudflareBlockedError);
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
    }
  });
});

describe("node loadSource dispose", () => {
  it("releases the source's store", async () => {
    const source = await loadSource(writerSource("token"), "test.writer", {
      settings: { get: () => ({}) },
    });
    const destroy = spyOn(GlobalStore.prototype, "destroy");
    try {
      source.dispose();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
    }
  });
});
