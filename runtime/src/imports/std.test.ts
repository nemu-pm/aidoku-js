import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import { createStdImports, parseRelativeDate } from "./std";

describe("std imports", () => {
  let store: GlobalStore | null = null;

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("exposes print for current aidoku-rs sources", () => {
    store = new GlobalStore("ja.rawkuma");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createStdImports(store) as Record<string, unknown>;

    expect(imports.print).toBeFunction();
    store.writeString("hello", 32);
    expect(() => (imports.print as (ptr: number, len: number) => void)(32, 5)).not.toThrow();
  });

  it("abort takes no arguments and throws with the last printed message", () => {
    store = new GlobalStore("ja.rawkuma");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createStdImports(store) as Record<string, unknown>;
    const print = imports.print as (ptr: number, len: number) => void;
    const abort = imports.abort as () => never;

    expect(abort).toBeFunction();
    // aidoku-rs panic handler: print(panic message) then abort()
    const message = "panicked at src/lib.rs:12:34";
    store.writeString(message, 64);
    print(64, message.length);

    expect(() => abort()).toThrow(`[ja.rawkuma] Source aborted: ${message}`);
  });

  it("abort throws even when nothing was printed", () => {
    store = new GlobalStore("ja.rawkuma");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createStdImports(store) as Record<string, unknown>;
    const abort = imports.abort as () => never;

    expect(() => abort()).toThrow("[ja.rawkuma] Source aborted");
  });
});

describe("std clock", () => {
  // 2026-03-15T12:00:00Z
  const PINNED_MS = Date.UTC(2026, 2, 15, 12, 0, 0);
  let store: GlobalStore | null = null;

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  function stdWith(clock?: Parameters<typeof createStdImports>[1]) {
    store = new GlobalStore("clock");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    return createStdImports(store, clock);
  }

  /** Call std.parse_date with a relative date string and the "current" zone. */
  function parseDate(imports: ReturnType<typeof createStdImports>, value: string): number {
    store!.writeString(value, 64);
    store!.writeString("yyyy-MM-dd", 128);
    store!.writeString("current", 192);
    return imports.parse_date(64, new TextEncoder().encode(value).length, 128, 10, 0, 0, 192, 7);
  }

  it("reads current_date, utc_offset and create_date(-1) from the host clock", () => {
    const imports = stdWith({ now: () => PINNED_MS });

    expect(imports.current_date()).toBe(PINNED_MS / 1000);
    expect(imports.utc_offset()).toBe(BigInt(-new Date(PINNED_MS).getTimezoneOffset() * 60));
    const rid = imports.create_date(-1);
    expect((store!.readStdValue(rid) as Date).getTime()).toBe(PINNED_MS);
  });

  it("parses relative dates against the host clock", () => {
    const imports = stdWith({ now: () => PINNED_MS });

    const expected = new Date(PINNED_MS);
    expected.setDate(expected.getDate() - 2);
    expect(parseDate(imports, "2 days ago")).toBe(Math.floor(expected.getTime() / 1000));
    expect(parseRelativeDate("just now", PINNED_MS)?.getTime()).toBe(PINNED_MS);
  });

  it("reads Date.now on every call when no clock is given", () => {
    const imports = stdWith();
    const originalNow = Date.now;
    // Hosts that virtualise time swap Date.now after the source is loaded.
    Date.now = () => PINNED_MS;
    try {
      expect(imports.current_date()).toBe(PINNED_MS / 1000);
      const rid = imports.create_date(-1);
      expect((store!.readStdValue(rid) as Date).getTime()).toBe(PINNED_MS);
      expect(parseRelativeDate("just now")?.getTime()).toBe(PINNED_MS);
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps explicit timestamps for create_date", () => {
    const imports = stdWith({ now: () => PINNED_MS });
    const rid = imports.create_date(1_000);
    expect((store!.readStdValue(rid) as Date).getTime()).toBe(1_000_000);
  });
});
