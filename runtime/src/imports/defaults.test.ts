import { afterEach, describe, expect, it } from "bun:test";
import { GlobalStore } from "../global-store";
import { encodeBool, encodeString, encodeVecString } from "../postcard";
import { framedResult } from "../testing/wasm-builder";
import { createDefaultsImports } from "./defaults";

const KEY_PTR = 16;
const VALUE_PTR = 256;

// aidoku-rs DefaultValue kinds
const Kind = { Data: 0, Bool: 1, String: 4, StringArray: 5, Null: 6 } as const;

describe("defaults.set", () => {
  let store: GlobalStore | null = null;

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  /** Write `key` and a framed `payload` into memory, then call defaults.set. */
  function set(kind: number, payload: ArrayLike<number> | null) {
    store = new GlobalStore("test.defaults");
    const memory = new WebAssembly.Memory({ initial: 1 });
    store.setMemory(memory);
    // Poison the bytes after the frame so an over-read would show up.
    new Uint8Array(memory.buffer).fill(0xee, VALUE_PTR, VALUE_PTR + 1024);

    const writes: [string, unknown][] = [];
    const imports = createDefaultsImports(
      store,
      () => undefined,
      (key, value) => writes.push([key, value])
    );

    const key = "oauth_token";
    store.writeString(key, KEY_PTR);
    if (payload) store.writeBytes(framedResult(payload), VALUE_PTR);
    const status = imports.set(KEY_PTR, key.length, kind, payload ? VALUE_PTR : 0);
    return { status, writes };
  }

  it("passes Data payloads through as the exact framed bytes", () => {
    const payload = [0x05, 0x80, 0x01, 0x02, 0x03, 0xff];
    const { status, writes } = set(Kind.Data, payload);

    expect(status).toBe(0);
    expect(writes).toEqual([["oauth_token", new Uint8Array(payload)]]);
  });

  it("decodes typed values from the framed payload", () => {
    expect(set(Kind.String, encodeString("token-123")).writes).toEqual([
      ["oauth_token", "token-123"],
    ]);
    expect(set(Kind.Bool, encodeBool(true)).writes).toEqual([["oauth_token", true]]);
    expect(set(Kind.StringArray, encodeVecString(["a", "b"])).writes).toEqual([
      ["oauth_token", ["a", "b"]],
    ]);
  });

  it("writes null for the Null kind without reading a value", () => {
    expect(set(Kind.Null, null).writes).toEqual([["oauth_token", null]]);
  });

  it("writes null when the value frame is empty", () => {
    expect(set(Kind.String, []).writes).toEqual([["oauth_token", null]]);
  });
});
