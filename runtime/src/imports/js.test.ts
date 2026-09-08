import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import { createJsImports } from "./js";

/**
 * Every symbol in the source SDK's `js` extern block, from
 * aidoku-rs `crates/lib/src/imports/js.rs`. A source importing any of these
 * fails to instantiate if the runtime does not provide it, even when the
 * function itself is unsupported here.
 */
const JS_MODULE_IMPORTS = [
  "context_create",
  "context_eval",
  "context_eval_async",
  "context_get",
  "webview_create",
  "webview_set_rule_list",
  "webview_load",
  "webview_load_html",
  "webview_wait_for_load",
  "webview_eval",
  "webview_eval_async",
  "webview_add_user_script",
  "webview_get_cookies",
  "webview_delete_cookie",
];

describe("js imports", () => {
  let store: GlobalStore | null = null;

  function createImports(): Record<string, (...args: number[]) => number> {
    store = new GlobalStore("ja.rawkuma");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    return createJsImports(store) as unknown as Record<string, (...args: number[]) => number>;
  }

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("provides every import a source may reference", () => {
    const imports = createImports();

    for (const name of JS_MODULE_IMPORTS) {
      expect(imports[name], name).toBeFunction();
    }
  });

  it("does not expose imports the module does not declare", () => {
    const imports = createImports();

    expect(Object.keys(imports).sort()).toEqual([...JS_MODULE_IMPORTS].sort());
  });

  it("evaluates code the same way through context_eval and context_eval_async", () => {
    const imports = createImports();
    const code = "1 + 2";
    store!.writeString(code, 64);

    const contextRid = imports.context_create();
    const syncResult = imports.context_eval(contextRid, 64, code.length);
    const asyncResult = imports.context_eval_async(contextRid, 64, code.length);

    expect(store!.readStdValue(syncResult)).toBe("3");
    expect(store!.readStdValue(asyncResult)).toBe("3");
  });

  it("rejects an unknown context from context_eval_async", () => {
    const imports = createImports();
    const code = "1";
    store!.writeString(code, 64);

    // InvalidContext
    expect(imports.context_eval_async(999, 64, code.length)).toBe(-2);
  });

  it("fails webview calls instead of trapping", () => {
    const imports = createImports();

    expect(imports.webview_create()).toBe(-1);
    expect(imports.webview_set_rule_list(1, 0, 0)).toBe(-1);
    expect(imports.webview_load(1, 2)).toBe(-1);
    expect(imports.webview_load_html(1, 0, 0, 0, 0)).toBe(-1);
    expect(imports.webview_wait_for_load(1)).toBe(-1);
    expect(imports.webview_eval(1, 0, 0)).toBe(-1);
    expect(imports.webview_eval_async(1, 0, 0)).toBe(-1);
    expect(imports.webview_add_user_script(1, 0, 0, 1, 1)).toBe(-1);
    expect(imports.webview_get_cookies(1)).toBe(-1);
    expect(imports.webview_delete_cookie(1, 0, 0, 0, 0, 0, 0)).toBe(-1);
  });

  it("logs an unsupported webview import only once", () => {
    const imports = createImports();
    const originalDebug = console.debug;
    let calls = 0;
    console.debug = () => {
      calls++;
    };

    try {
      imports.webview_create();
      imports.webview_create();
      imports.webview_create();
    } finally {
      console.debug = originalDebug;
    }

    expect(calls).toBe(1);
  });
});
