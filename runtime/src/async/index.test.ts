import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Comlink from "comlink";
import { loadSource } from "./index";
import { CloudflareBlockedError } from "../imports/net";
import type { SourceManifest } from "../types";

const manifest: SourceManifest = {
  info: { id: "test.browser", name: "Browser Source", version: 1 },
};

/** Minimal AIX bytes: loadSource only checks the zip magic before the worker. */
const aixBytes = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

const challenge = () => new CloudflareBlockedError("https://example.com/", 403);

/**
 * Stand-in for the worker: a Comlink endpoint over a MessageChannel serving
 * `FakeWorker.api` in-process, so the real browser loadSource wiring runs.
 */
class FakeWorker {
  static api: Record<string, unknown> = {};
  static instances: FakeWorker[] = [];
  terminated = false;
  private port: MessagePort;

  constructor() {
    const { port1, port2 } = new MessageChannel();
    Comlink.expose(FakeWorker.api, port2);
    port1.start();
    this.port = port1;
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer?: Transferable[]) {
    this.port.postMessage(message, transfer ?? []);
  }

  addEventListener(type: string, listener: EventListener) {
    this.port.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.port.removeEventListener(type, listener);
  }

  terminate() {
    this.terminated = true;
    this.port.close();
  }
}

/** A worker API whose `method` throws a challenge for the first `failures` calls. */
function workerApi(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const api: Record<string, unknown> = {
    load: () => ({ success: true, manifest }),
    initialize: () => void calls.push("initialize"),
    updateSettings: () => {},
    ...overrides,
  };
  return { api, calls };
}

function failingTimes<T>(failures: number, value: T, calls: string[], name: string) {
  let attempts = 0;
  return () => {
    calls.push(name);
    attempts++;
    if (attempts <= failures) throw challenge();
    return value;
  };
}

describe("browser loadSource", () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    FakeWorker.instances = [];
    (globalThis as { Worker: unknown }).Worker = FakeWorker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
    for (const worker of FakeWorker.instances) worker.terminate();
  });

  it("initializes the source after load, retrying a Cloudflare challenge", async () => {
    const calls: string[] = [];
    const { api } = workerApi({ initialize: failingTimes(1, undefined, calls, "initialize") });
    FakeWorker.api = api;
    const solved: string[] = [];

    const source = await loadSource(aixBytes(), "test.browser", {
      cloudflareSolver: async (info) => {
        solved.push(info.url);
        return true;
      },
    });

    expect(source.id).toBe("test.browser");
    expect(calls).toEqual(["initialize", "initialize"]);
    expect(solved).toEqual(["https://example.com/"]);
  });

  it("rejects with the challenge and terminates the worker when it is not solved", async () => {
    const calls: string[] = [];
    FakeWorker.api = workerApi({ initialize: failingTimes(99, undefined, calls, "initialize") }).api;

    await expect(loadSource(aixBytes(), "test.browser")).rejects.toBeInstanceOf(
      CloudflareBlockedError
    );
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("retries logins and notifications after a challenge is solved", async () => {
    const calls: string[] = [];
    FakeWorker.api = workerApi({
      handleBasicLogin: failingTimes(1, true, calls, "basic"),
      handleWebLogin: failingTimes(1, true, calls, "web"),
      handleNotification: failingTimes(1, undefined, calls, "notification"),
    }).api;

    const source = await loadSource(aixBytes(), "test.browser", {
      cloudflareSolver: async () => true,
    });

    expect(await source.handleBasicLogin("login", "alice", "pw")).toBe(true);
    expect(await source.handleWebLogin("login", { session: "abc" })).toBe(true);
    expect(await source.handleNotification("nemu://oauth")).toBeUndefined();
    expect(calls).toEqual(["basic", "basic", "web", "web", "notification", "notification"]);
  });
});
