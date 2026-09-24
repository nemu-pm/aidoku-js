import { describe, expect, it } from "bun:test";
import { loadSource } from "./index.node";
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
