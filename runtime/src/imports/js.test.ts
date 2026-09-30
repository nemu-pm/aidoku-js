import { describe, expect, it, afterEach } from "bun:test";
import vm from "node:vm";
import { GlobalStore } from "../global-store";
import type { JsEvaluator, JsEvaluatorContext } from "../types";
import { createJsImports } from "./js";
import { createStdImports } from "./std";

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

/**
 * A host evaluator shaped like Aidoku iOS: every context is a separate realm
 * (node:vm here, JavaScriptCore there) whose globals persist across evals, and
 * results are stringified the way `JSValue.toString()` does.
 */
class VmEvaluator implements JsEvaluator {
  readonly log: string[] = [];
  created = 0;
  disposed = 0;

  createContext(): JsEvaluatorContext {
    const id = ++this.created;
    const realm = vm.createContext({});
    const run = (script: string): string => {
      try {
        return String(vm.runInContext(script, realm, { timeout: 1000 }));
      } catch {
        // JSContext.evaluateScript yields undefined after an exception.
        return "undefined";
      }
    };
    return {
      eval: (script) => {
        this.log.push(`${id}:eval:${script}`);
        return run(script);
      },
      evalAsync: (script) => {
        this.log.push(`${id}:evalAsync:${script}`);
        return run(script);
      },
      get: (name) => {
        this.log.push(`${id}:get:${name}`);
        // JSContext.objectForKeyedSubscript: a missing global is undefined.
        return run(`globalThis[${JSON.stringify(name)}]`);
      },
      dispose: () => {
        this.log.push(`${id}:dispose`);
        this.disposed++;
      },
    };
  }
}

describe("js imports with a host evaluator", () => {
  let store: GlobalStore | null = null;

  function setup(evaluator: JsEvaluator) {
    store = new GlobalStore("zh.copymanga");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const js = createJsImports(store, evaluator) as unknown as Record<
      string,
      (...args: number[]) => number
    >;
    const std = createStdImports(store) as unknown as Record<
      string,
      (...args: number[]) => number
    >;
    return { js, std, store };
  }

  function write(text: string, offset = 256): [number, number] {
    const bytes = new TextEncoder().encode(text);
    store!.writeBytes(bytes, offset);
    return [offset, bytes.length];
  }

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("routes context_create/eval/eval_async/get to the host context", () => {
    const evaluator = new VmEvaluator();
    const { js, store } = setup(evaluator);

    const ctx = js.context_create();
    expect(evaluator.created).toBe(1);
    expect(store.readStdValue(js.context_eval(ctx, ...write("var answer = 6 * 7; answer")))).toBe("42");
    // Globals persist within one context, as with a JSContext.
    expect(store.readStdValue(js.context_get(ctx, ...write("answer")))).toBe("42");
    expect(store.readStdValue(js.context_eval_async(ctx, ...write("answer + 1")))).toBe("43");
    expect(evaluator.log).toEqual([
      "1:eval:var answer = 6 * 7; answer",
      "1:get:answer",
      "1:evalAsync:answer + 1",
    ]);
  });

  it("falls back to eval for context_eval_async when the host has no evalAsync", () => {
    const calls: string[] = [];
    const { js, store } = setup({
      createContext: () => ({
        eval: (script) => {
          calls.push(script);
          return "ok";
        },
        get: () => null,
      }),
    });

    const ctx = js.context_create();
    expect(store.readStdValue(js.context_eval_async(ctx, ...write("p")))).toBe("ok");
    expect(calls).toEqual(["p"]);
  });

  it("keeps separate contexts isolated", () => {
    const evaluator = new VmEvaluator();
    const { js, store } = setup(evaluator);

    const first = js.context_create();
    const second = js.context_create();
    js.context_eval(first, ...write("var secret = 'first'"));

    expect(store.readStdValue(js.context_get(first, ...write("secret")))).toBe("first");
    // The second realm never saw `secret`.
    expect(store.readStdValue(js.context_get(second, ...write("secret")))).toBe("undefined");
  });

  it("parses a copymanga-style single-quoted list through JSON.stringify", () => {
    // zh.copymanga v21 (FiltersPage::manga_page_result) evaluates the
    // `list` attribute, a JS literal with single quotes, as
    // `JSON.stringify(<literal>)` and parses the result with serde_json.
    const evaluator = new VmEvaluator();
    const { js, std, store } = setup(evaluator);
    const literal =
      "[{'name':'\u9032\u64ca\u7684\u5de8\u4eba','path_word':'jinjidejuren','cover':'https://img/c.jpg','author':[{'name':'\u8aeb\u5c71\u5275'}]}]";

    // A live descriptor from earlier in the call (the HTML document, say)
    // must survive the context's drop.
    const earlier = store.storeStdValue("document");

    const ctx = js.context_create();
    const result = js.context_eval(ctx, ...write(`JSON.stringify(${literal})`));
    // JsContext is dropped at the end of the statement: std.destroy(rid).
    std.destroy(ctx);

    expect(JSON.parse(store.readStdValue(result) as string)).toEqual([
      {
        name: "進擊的巨人",
        path_word: "jinjidejuren",
        cover: "https://img/c.jpg",
        author: [{ name: "諫山創" }],
      },
    ]);
    expect(evaluator.disposed).toBe(1);
    expect(store.readStdValue(earlier)).toBe("document");
    // The destroyed context is gone.
    expect(js.context_eval(ctx, ...write("1"))).toBe(-2);
  });

  it("returns MissingResult when the host has no result", () => {
    const { js } = setup({
      createContext: () => ({ eval: () => null, get: () => null }),
    });

    const ctx = js.context_create();
    expect(js.context_eval(ctx, ...write("x"))).toBe(-1);
    expect(js.context_eval_async(ctx, ...write("x"))).toBe(-1);
    expect(js.context_get(ctx, ...write("x"))).toBe(-1);
  });

  it("checks the context before the string, like Aidoku iOS", () => {
    const { js, store } = setup(new VmEvaluator());

    // Unknown RID and a RID that is not a JS context are both invalid.
    expect(js.context_eval(999, 0, 0)).toBe(-2);
    const notAContext = store.storeStdValue("text");
    expect(js.context_eval(notAContext, ...write("1"))).toBe(-2);

    const ctx = js.context_create();
    expect(js.context_eval(ctx, 0, 0)).toBe(-3);
    expect(js.context_eval(ctx, -1, 4)).toBe(-3);
    expect(js.context_get(ctx, 0, 0)).toBe(-3);
  });

  it("lets host exceptions escape the WASM call", () => {
    class Suspend extends Error {}
    const { js } = setup({
      createContext: () => ({
        eval: () => {
          throw new Suspend("needs host evaluation");
        },
        get: () => null,
      }),
    });

    const ctx = js.context_create();
    expect(() => js.context_eval(ctx, ...write("1"))).toThrow(Suspend);
  });

  it("disposes contexts the source never destroyed when the store is torn down", () => {
    const evaluator = new VmEvaluator();
    const { js, store } = setup(evaluator);

    js.context_create();
    js.context_create();
    store.destroy();

    expect(evaluator.disposed).toBe(2);
  });

  it("keeps releasing the store when a host dispose throws", () => {
    const { js, std, store } = setup({
      createContext: () => ({
        eval: () => "",
        get: () => null,
        dispose: () => {
          throw new Error("boom");
        },
      }),
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const ctx = js.context_create();
      std.destroy(ctx);
      expect(store.getResourceType(ctx)).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("js imports without a host evaluator", () => {
  it("stores built-in contexts as destroyable resources", () => {
    const store = new GlobalStore("test");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const js = createJsImports(store) as unknown as Record<string, (...args: number[]) => number>;
    const std = createStdImports(store) as unknown as Record<string, (...args: number[]) => number>;
    try {
      const earlier = store.storeStdValue("document");
      const ctx = js.context_create();
      expect(ctx).not.toBe(earlier);
      const code = "JSON.stringify({'a': 1})";
      store.writeString(code, 64);
      expect(store.readStdValue(js.context_eval(ctx, 64, code.length))).toBe('{"a":1}');

      std.destroy(ctx);
      expect(store.readStdValue(earlier)).toBe("document");
      expect(js.context_eval(ctx, 64, code.length)).toBe(-2);
    } finally {
      store.destroy();
    }
  });
});
