import { afterEach, describe, expect, it } from "bun:test";
import { GlobalStore } from "../global-store";
import { decodeString, encodeBool, encodeString, encodeVecString } from "../postcard";
import { framedResult } from "../testing/wasm-builder";
import { createDefaultsImports } from "./defaults";
import { createStdImports } from "./std";

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

describe("defaults Data round trip", () => {
  let store: GlobalStore | null = null;

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  /**
   * defaults_set_data(key, value) followed by defaults_get::<T>(key), the way
   * aidoku-rs does them: set passes the framed postcard encoding with kind 0,
   * get reads the returned rid through std.buffer_len / std.read_buffer and
   * postcard-decodes it.
   */
  function roundTrip(payload: Uint8Array, persist: (value: unknown) => unknown = (v) => v) {
    store = new GlobalStore("test.defaults");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const saved = new Map<string, unknown>();
    const defaults = createDefaultsImports(
      store,
      (key) => saved.get(key),
      (key, value) => saved.set(key, persist(value))
    );
    const std = createStdImports(store);

    const key = "auth";
    store.writeString(key, KEY_PTR);
    store.writeBytes(framedResult(payload), VALUE_PTR);
    expect(defaults.set(KEY_PTR, key.length, Kind.Data, VALUE_PTR)).toBe(0);

    const rid = defaults.get(KEY_PTR, key.length);
    expect(rid).toBeGreaterThan(0);
    const len = std.buffer_len(rid);
    const readPtr = 2048;
    expect(std.read_buffer(rid, readPtr, len)).toBe(0);
    return store.readBytes(readPtr, len)!;
  }

  it("reads back the exact bytes a source stored", () => {
    // postcard String "abc", as a LoginStatus-like payload would be encoded
    const payload = encodeString("abc");
    const bytes = roundTrip(payload);

    expect(bytes).toEqual(payload);
    expect(decodeString(bytes, 0)[0]).toBe("abc");
  });

  it("reads back bytes a host persisted as an ArrayBuffer or another view", () => {
    const payload = new Uint8Array([3, 97, 98, 99]);
    expect(roundTrip(payload, (v) => (v as Uint8Array).slice().buffer)).toEqual(payload);
    expect(
      roundTrip(payload, (v) => new DataView((v as Uint8Array).slice().buffer))
    ).toEqual(payload);
  });
});
