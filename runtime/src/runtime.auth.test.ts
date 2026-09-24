import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createLoadSource, type AidokuSource, type CanvasModule } from "./runtime";
import { GlobalStore } from "./global-store";
import { encodeString, encodeVecString } from "./postcard";
import { buildWasm, framedResult, op, type WasmFunctionSpec } from "./testing/wasm-builder";
import type { HttpBridge, SourceManifest } from "./types";

const TRUE_RESULT_PTR = 16;
const FALSE_RESULT_PTR = 32;

const stubCanvasModule: CanvasModule = {
  createCanvasImports: () => ({}),
  createHostImage: async () => null,
  getHostImageData: () => null,
};

const stubHttpBridge: HttpBridge = {
  request: () => ({ status: 200, headers: {}, body: "", bytes: null }),
};

const manifest: SourceManifest = {
  info: { id: "test.auth", name: "Auth Source", version: 1 },
};

/** An export taking `params` descriptors and returning a fixed result. */
function returning(name: string, params: number, value: number): WasmFunctionSpec {
  return { name, params, results: 1, body: op.i32Const(value) };
}

function loadAuthSource(functions: WasmFunctionSpec[]): Promise<AidokuSource> {
  const wasmBytes = buildWasm({
    functions,
    data: [
      { offset: TRUE_RESULT_PTR, bytes: framedResult([0x01]) },
      { offset: FALSE_RESULT_PTR, bytes: framedResult([0x00]) },
    ],
  });
  return createLoadSource(stubCanvasModule)({ wasmBytes, manifest }, "test.auth", {
    httpBridge: stubHttpBridge,
  });
}

/** Records every value the source's store is handed, and the store itself. */
function recordStoredValues() {
  const stored: unknown[] = [];
  let store: GlobalStore | null = null;
  const original = GlobalStore.prototype.storeStdValue;
  const spy = spyOn(GlobalStore.prototype, "storeStdValue").mockImplementation(function (
    this: GlobalStore,
    value: unknown
  ) {
    store = this;
    stored.push(value);
    return original.call(this, value);
  });
  return {
    stored,
    descriptorCount: () => store?.getStats().descriptorCount ?? 0,
    restore: () => spy.mockRestore(),
  };
}

describe("auth handlers", () => {
  let recorder: ReturnType<typeof recordStoredValues> | null = null;

  afterEach(() => {
    recorder?.restore();
    recorder = null;
  });

  it("reports which login flows the source handles", async () => {
    const source = await loadAuthSource([returning("handle_basic_login", 3, TRUE_RESULT_PTR)]);
    expect(source.handlesBasicLogin).toBe(true);
    expect(source.handlesWebLogin).toBe(false);
  });

  it("submits basic credentials and returns the source's verdict", async () => {
    const accepting = await loadAuthSource([returning("handle_basic_login", 3, TRUE_RESULT_PTR)]);
    recorder = recordStoredValues();

    expect(accepting.handleBasicLogin("login", "alice", "hunter2")).toBe(true);
    expect(recorder.stored).toEqual([
      encodeString("login"),
      encodeString("alice"),
      encodeString("hunter2"),
    ]);
    // The argument descriptors are released once the call returns.
    expect(recorder.descriptorCount()).toBe(0);

    const rejecting = await loadAuthSource([returning("handle_basic_login", 3, FALSE_RESULT_PTR)]);
    expect(rejecting.handleBasicLogin("login", "alice", "wrong")).toBe(false);
  });

  it("submits web login cookies as parallel key and value lists", async () => {
    const source = await loadAuthSource([returning("handle_web_login", 3, TRUE_RESULT_PTR)]);
    recorder = recordStoredValues();

    expect(source.handleWebLogin("login", { session: "abc", cf_clearance: "xyz" })).toBe(true);
    expect(recorder.stored).toEqual([
      encodeString("login"),
      encodeVecString(["session", "cf_clearance"]),
      encodeVecString(["abc", "xyz"]),
    ]);
    expect(recorder.descriptorCount()).toBe(0);
  });

  it("surfaces a failed login as an error with the result message", async () => {
    const source = await loadAuthSource([
      returning("handle_basic_login", 3, -3),
      returning("handle_web_login", 3, -2),
    ]);

    expect(() => source.handleBasicLogin("login", "alice", "pw")).toThrow("Request error");
    expect(() => source.handleWebLogin("login", {})).toThrow("Unimplemented");
  });

  it("returns false without calling into the source when a login export is missing", async () => {
    const source = await loadAuthSource([]);

    expect(source.handleBasicLogin("login", "alice", "pw")).toBe(false);
    expect(source.handleWebLogin("login", { a: "b" })).toBe(false);
  });

  it("delivers notifications and surfaces failures", async () => {
    const ok = await loadAuthSource([returning("handle_notification", 1, 0)]);
    recorder = recordStoredValues();
    expect(() => ok.handleNotification("nemu://oauth?code=1")).not.toThrow();
    expect(recorder.stored).toEqual([encodeString("nemu://oauth?code=1")]);
    expect(recorder.descriptorCount()).toBe(0);

    const failing = await loadAuthSource([returning("handle_notification", 1, -1)]);
    expect(() => failing.handleNotification("x")).toThrow("Source error");

    const missing = await loadAuthSource([]);
    expect(() => missing.handleNotification("x")).not.toThrow();
  });
});
