/**
 * js namespace - JavaScript execution context
 */
import type { GlobalStore } from "../global-store";

// Result codes matching Rust implementation
const JsResult = {
  MissingResult: -1,
  InvalidContext: -2,
  InvalidString: -3,
} as const;

/**
 * Simple JavaScript execution context
 * Uses Function constructor for sandboxed evaluation
 */
class JsContext {
  private variables: Map<string, unknown> = new Map();

  /**
   * Evaluate JavaScript code and return the result as a string
   */
  eval(code: string): string | null {
    try {
      // Build context object from stored variables
      const contextObj: Record<string, unknown> = {};
      for (const [key, value] of this.variables) {
        contextObj[key] = value;
      }

      // Create function with context variables as parameters
      const paramNames = Object.keys(contextObj);
      const paramValues = Object.values(contextObj);

      // Wrap code to return the expression value
      // If the code doesn't have explicit return, we add one
      const wrappedCode = `
        "use strict";
        return (${code});
      `;

      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...paramNames, wrappedCode);
      const result = fn(...paramValues);

      // Convert result to string
      if (result === undefined || result === null) {
        return "";
      }
      if (typeof result === "object") {
        return JSON.stringify(result);
      }
      return String(result);
    } catch {
      // If wrapping with return fails (e.g., statements), try without
      try {
        const contextObj: Record<string, unknown> = {};
        for (const [key, value] of this.variables) {
          contextObj[key] = value;
        }
        const paramNames = Object.keys(contextObj);
        const paramValues = Object.values(contextObj);

        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(...paramNames, `"use strict"; ${code}`);
        const result = fn(...paramValues);

        if (result === undefined || result === null) {
          return "";
        }
        if (typeof result === "object") {
          return JSON.stringify(result);
        }
        return String(result);
      } catch (e2) {
        console.error("[js.eval] Error:", e2);
        return null;
      }
    }
  }

  /**
   * Get a variable from the context
   */
  get(name: string): string | null {
    const value = this.variables.get(name);
    if (value === undefined) {
      return null;
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Set a variable in the context
   */
  set(name: string, value: unknown): void {
    this.variables.set(name, value);
  }
}

export function createJsImports(store: GlobalStore) {
  // Map of context RIDs to JsContext instances
  const contexts = new Map<number, JsContext>();
  let nextContextId = 1;

  // Webviews are unsupported here; log the first call per import so a source
  // relying on one is diagnosable without flooding the console.
  const loggedUnsupported = new Set<string>();
  const unsupportedWebview = (name: string): number => {
    if (!loggedUnsupported.has(name)) {
      loggedUnsupported.add(name);
      console.debug(`[js.${name}] Webviews are not supported in this runtime`);
    }
    return JsResult.MissingResult;
  };

  /**
   * Evaluate JavaScript code in a context.
   * @param contextRid - Context RID
   * @param stringPtr - Pointer to JS code string
   * @param stringLen - Length of JS code string
   * Returns: String descriptor with result, or negative error code
   */
  const contextEval = (contextRid: number, stringPtr: number, stringLen: number): number => {
    if (stringLen <= 0) {
      return JsResult.InvalidString;
    }

    const context = contexts.get(contextRid);
    if (!context) {
      console.error(`[js.context_eval] Invalid context: ${contextRid}`);
      return JsResult.InvalidContext;
    }

    const code = store.readString(stringPtr, stringLen);
    if (!code) {
      return JsResult.InvalidString;
    }

    console.debug(`[js.context_eval] Evaluating in context ${contextRid}:`, code.slice(0, 100));

    const result = context.eval(code);
    if (result === null) {
      return JsResult.MissingResult;
    }

    // Store result string and return its descriptor
    return store.storeStdValue(result);
  };

  return {
    /**
     * Create a new JavaScript context
     * Returns: RID (resource ID) for the context
     */
    context_create: (): number => {
      const rid = nextContextId++;
      contexts.set(rid, new JsContext());
      console.debug(`[js.context_create] Created context ${rid}`);
      return rid;
    },

    /** Evaluate JavaScript code in a context */
    context_eval: contextEval,

    /**
     * Evaluate JavaScript code in a context, awaiting a promise result.
     * Context evaluation here is synchronous, so this behaves exactly like
     * context_eval: a returned promise is stringified rather than awaited.
     */
    context_eval_async: contextEval,

    /**
     * Get a variable from a context
     * @param contextRid - Context RID
     * @param stringPtr - Pointer to variable name
     * @param stringLen - Length of variable name
     * Returns: String descriptor with value, or negative error code
     */
    context_get: (contextRid: number, stringPtr: number, stringLen: number): number => {
      if (stringLen <= 0) {
        return JsResult.InvalidString;
      }

      const context = contexts.get(contextRid);
      if (!context) {
        return JsResult.InvalidContext;
      }

      const varName = store.readString(stringPtr, stringLen);
      if (!varName) {
        return JsResult.InvalidString;
      }

      const result = context.get(varName);
      if (result === null) {
        return JsResult.MissingResult;
      }

      return store.storeStdValue(result);
    },

    // Webview stubs. Every symbol a source may import has to exist, otherwise
    // WASM instantiation fails, so all of them resolve to a failure code.
    webview_create: (): number => unsupportedWebview("webview_create"),
    webview_set_rule_list: (
      _webviewRid: number,
      _rulesPtr: number,
      _rulesLen: number
    ): number => unsupportedWebview("webview_set_rule_list"),
    webview_load: (_webviewRid: number, _requestRid: number): number =>
      unsupportedWebview("webview_load"),
    webview_load_html: (
      _webviewRid: number,
      _htmlPtr: number,
      _htmlLen: number,
      _urlPtr: number,
      _urlLen: number
    ): number => unsupportedWebview("webview_load_html"),
    webview_wait_for_load: (_webviewRid: number): number =>
      unsupportedWebview("webview_wait_for_load"),
    webview_eval: (_webviewRid: number, _codePtr: number, _codeLen: number): number =>
      unsupportedWebview("webview_eval"),
    webview_eval_async: (
      _webviewRid: number,
      _codePtr: number,
      _codeLen: number
    ): number => unsupportedWebview("webview_eval_async"),
    webview_add_user_script: (
      _webviewRid: number,
      _scriptPtr: number,
      _scriptLen: number,
      _atDocumentEnd: number,
      _forMainFrameOnly: number
    ): number => unsupportedWebview("webview_add_user_script"),
    webview_get_cookies: (_webviewRid: number): number =>
      unsupportedWebview("webview_get_cookies"),
    webview_delete_cookie: (
      _webviewRid: number,
      _namePtr: number,
      _nameLen: number,
      _valuePtr: number,
      _valueLen: number,
      _domainPtr: number,
      _domainLen: number
    ): number => unsupportedWebview("webview_delete_cookie"),
  };
}

