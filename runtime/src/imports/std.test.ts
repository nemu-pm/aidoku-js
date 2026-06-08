import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import { createStdImports } from "./std";

function writeAssemblyScriptString(
  store: GlobalStore,
  ptr: number,
  value: string
): void {
  const bytes = new TextEncoder().encode(value);
  const view = new DataView(store.memory!.buffer);
  view.setInt32(ptr - 4, bytes.length, true);
  store.writeBytes(bytes, ptr);
}

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

  it("exposes abort with readable source-scoped errors", () => {
    store = new GlobalStore("ja.rawkuma");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createStdImports(store) as Record<string, unknown>;

    expect(imports.abort).toBeFunction();
    writeAssemblyScriptString(store, 64, "boom");
    writeAssemblyScriptString(store, 128, "src/lib.rs");

    expect(() =>
      (imports.abort as (msgPtr: number, filePtr: number, line: number, col: number) => never)(
        64,
        128,
        12,
        34
      )
    ).toThrow("[ja.rawkuma] Abort: boom at src/lib.rs:12:34");
  });
});
