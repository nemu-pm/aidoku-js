import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import { createStdImports } from "./std";

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
