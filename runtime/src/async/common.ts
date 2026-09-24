/**
 * Shared utilities for async runtimes (Node and Browser)
 */
import type { SourceManifest, HomeLayout } from "../types";
import type { AidokuSource } from "../runtime";
import type { AsyncAidokuSource, CustomFetchFn } from "./types";
import type { CloudflareBlockedError } from "../imports/net";
import { solveViaAgent } from "../cloudflare/agent";
import {
  hostFromUrl,
  type CloudflareChallengeInfo,
  type CloudflareChallengeSolver,
} from "../cloudflare/detect";

/**
 * Limits for reading defaults out of a source's settings.json. The schema is
 * source-controlled input, so extraction is bounded in depth, node count and
 * total string size.
 */
const SETTING_DEFAULT_LIMITS = Object.freeze({
  /** Nesting depth of group/page items */
  depth: 32,
  /** Schema nodes inspected in total */
  nodes: 1024,
  /** Items in a list default */
  listItems: 256,
  keyLength: 256,
  /** Length of one string default (or list item) */
  stringLength: 4096,
  /** Characters across all keys and string defaults */
  schemaStringChars: 1048576,
  /** Largest absolute numeric default */
  absoluteNumber: 1000000000000,
});

/** Setting types that carry a default value */
const SETTING_DEFAULT_TYPES = new Set([
  "select",
  "picker",
  "multi-select",
  "multi-single-select",
  "switch",
  "slider",
  "stepper",
  "segment",
  "text",
  "editable-list",
]);

interface SanitizedDefault {
  value: unknown;
  /** String characters the value consumes from the schema budget */
  stringChars: number;
}

/** An own data property, without running getters or proxy traps that throw. */
function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function asArray(value: unknown): unknown[] | null {
  try {
    return Array.isArray(value) ? value : null;
  } catch {
    // Array.isArray throws for a revoked proxy
    return null;
  }
}

function arrayLength(value: unknown[]): number {
  const length = ownDataValue(value, "length");
  return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

function arrayValue(value: unknown[], index: number): unknown {
  return ownDataValue(value, String(index));
}

function asPlainRecord(value: unknown): object | null {
  if (!value || typeof value !== "object" || asArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value : null;
  } catch {
    return null;
  }
}

/** Control, bidi and invisible formatting characters are not allowed in keys. */
function isUnsafeKeyCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0xad ||
    codePoint === 0x61c ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff;
}

function safeSettingKey(value: unknown): string | null {
  if (typeof value !== "string" ||
    value.length === 0 ||
    value.length > SETTING_DEFAULT_LIMITS.keyLength ||
    value.trim().length === 0) {
    return null;
  }
  for (const character of value) {
    if (isUnsafeKeyCodePoint(character.codePointAt(0) ?? 0)) return null;
  }
  return value;
}

function finiteSettingNumber(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= SETTING_DEFAULT_LIMITS.absoluteNumber
    ? value
    : null;
}

function sanitizeStringDefault(value: unknown, remainingStringChars: number): SanitizedDefault | null {
  if (typeof value !== "string" ||
    value.length > SETTING_DEFAULT_LIMITS.stringLength ||
    value.length > remainingStringChars) {
    return null;
  }
  return { value, stringChars: value.length };
}

function sanitizeStringArrayDefault(value: unknown, remainingStringChars: number): { value: string[]; stringChars: number } | null {
  const input = asArray(value);
  if (!input) return null;
  const length = arrayLength(input);
  if (length > SETTING_DEFAULT_LIMITS.listItems) return null;
  const output: string[] = [];
  let stringChars = 0;
  for (let index = 0; index < length; index += 1) {
    const item = arrayValue(input, index);
    if (typeof item !== "string" ||
      item.length > SETTING_DEFAULT_LIMITS.stringLength ||
      stringChars + item.length > remainingStringChars) {
      return null;
    }
    output.push(item);
    stringChars += item.length;
  }
  return { value: output, stringChars };
}

function sanitizeSettingDefault(
  type: string,
  value: unknown,
  record: object,
  remainingStringChars: number
): SanitizedDefault | null {
  // A picker is a select presented as a wheel; both hold the chosen value.
  if (type === "select" || type === "picker" || type === "text") {
    return sanitizeStringDefault(value, remainingStringChars);
  }
  if (type === "multi-select" ||
    type === "multi-single-select" ||
    type === "editable-list") {
    const result = sanitizeStringArrayDefault(value, remainingStringChars);
    // A single-choice list keeps only its first entry.
    if (type !== "multi-single-select" || !result || result.value.length <= 1) return result;
    return {
      value: result.value.slice(0, 1),
      stringChars: result.value[0].length,
    };
  }
  if (type === "switch") {
    return typeof value === "boolean" ? { value, stringChars: 0 } : null;
  }
  if (type === "segment") {
    return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= SETTING_DEFAULT_LIMITS.absoluteNumber
      ? { value, stringChars: 0 }
      : null;
  }
  if (type === "slider" || type === "stepper") {
    const number = finiteSettingNumber(value);
    if (number === null) return null;
    const rawMinimum = finiteSettingNumber(ownDataValue(record, "min")) ??
      finiteSettingNumber(ownDataValue(record, "minimumValue")) ??
      0;
    const rawMaximum = finiteSettingNumber(ownDataValue(record, "max")) ??
      finiteSettingNumber(ownDataValue(record, "maximumValue")) ??
      100;
    const minimum = Math.min(rawMinimum, rawMaximum);
    const maximum = Math.max(rawMinimum, rawMaximum);
    return {
      value: Math.min(maximum, Math.max(minimum, number)),
      stringChars: 0,
    };
  }
  return null;
}

/**
 * Extract default values from settings.json, as iOS Aidoku does
 * (Source.swift), before the source is initialized.
 *
 * settings.json is source-controlled, so only bounded, type-compatible
 * defaults are kept: known setting types with a safe key, a value of the
 * type's shape (clamped to a slider/stepper's range; a multi-single-select
 * keeps its first entry), found within the depth, node and size limits.
 * Getters and proxies are never invoked, the first occurrence of a key wins,
 * and the result has no prototype so keys like `__proto__` stay plain data.
 * Callers spread it into their own settings object.
 */
export function extractSettingsDefaults(settingsJson: unknown): Record<string, unknown> {
  const defaults: Record<string, unknown> = Object.create(null);
  const root = asArray(settingsJson);
  if (!root) return defaults;

  const seenRecords = new WeakSet<object>();
  const seenArrays = new WeakSet<unknown[]>([root]);
  const claimedKeys = new Set<string>();
  const stack: { input: unknown[]; length: number; index: number; depth: number }[] = [{
    input: root,
    length: arrayLength(root),
    index: 0,
    depth: 0,
  }];
  let inspectedNodes = 0;
  let remainingStringChars = SETTING_DEFAULT_LIMITS.schemaStringChars;

  while (stack.length > 0 && inspectedNodes < SETTING_DEFAULT_LIMITS.nodes) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.length) {
      stack.pop();
      continue;
    }
    const rawNode = arrayValue(frame.input, frame.index++);
    inspectedNodes += 1;
    const record = asPlainRecord(rawNode);
    if (!record || seenRecords.has(record)) continue;
    seenRecords.add(record);

    const type = ownDataValue(record, "type");
    if (type === "group" || type === "page") {
      const children = asArray(ownDataValue(record, "items"));
      if (children &&
        frame.depth < SETTING_DEFAULT_LIMITS.depth &&
        !seenArrays.has(children)) {
        seenArrays.add(children);
        stack.push({
          input: children,
          length: arrayLength(children),
          index: 0,
          depth: frame.depth + 1,
        });
      }
      continue;
    }
    if (typeof type !== "string" || !SETTING_DEFAULT_TYPES.has(type)) continue;

    const key = safeSettingKey(ownDataValue(record, "key"));
    if (!key || claimedKeys.has(key) || key.length > remainingStringChars) continue;
    const defaultValue = ownDataValue(record, "default");
    if (defaultValue === undefined) continue;
    const sanitized = sanitizeSettingDefault(type, defaultValue, record, remainingStringChars - key.length);
    if (!sanitized) continue;

    Object.defineProperty(defaults, key, {
      value: sanitized.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    claimedKeys.add(key);
    remainingStringChars -= key.length + sanitized.stringChars;
    if (remainingStringChars <= 0) break;
  }

  return defaults;
}

/**
 * Apply manifest-based defaults (url, languages)
 */
export function applyManifestDefaults(
  settings: Record<string, unknown>,
  manifest: SourceManifest
): void {
  // URL default from allowsBaseUrlSelect
  if (manifest.config?.allowsBaseUrlSelect && manifest.info.urls?.length) {
    if (settings.url === undefined) {
      settings.url = manifest.info.urls[0];
    }
  }
  // Languages default
  if (manifest.info.languages?.length) {
    if (settings.languages === undefined) {
      const selectType = manifest.config?.languageSelectType ?? "single";
      settings.languages = selectType === "multi"
        ? manifest.info.languages
        : [manifest.info.languages[0]];
    }
  }
}

/** Solve-and-retry rounds allowed for a single call. */
const MAX_CF_SOLVE_ROUNDS = 2;

/**
 * Create CF retry wrapper
 *
 * Retries a failed call after a Cloudflare challenge has been cleared, either
 * by a caller-supplied solver or by the agent. Concurrent calls blocked by the
 * same host share one solve, and a call gets up to MAX_CF_SOLVE_ROUNDS rounds,
 * since a fresh challenge can be issued right after the first clearance.
 *
 * @param agentUrl - Agent base URL, used when no solver is given
 * @param solver - Challenge solver; takes precedence over the agent
 */
export function createCfRetry(
  agentUrl?: string,
  solver?: CloudflareChallengeSolver
): <T>(fn: () => T) => Promise<T> {
  // One in-flight solve per host, so N parallel requests trigger one challenge.
  const pendingSolves = new Map<string, Promise<boolean>>();

  const solveChallenge = (info: CloudflareChallengeInfo): Promise<boolean> => {
    const key = info.host || info.url;
    const pending = pendingSolves.get(key);
    if (pending) return pending;

    const attempt = (async () => {
      try {
        if (solver) return await solver(info);
        if (agentUrl) return await solveViaAgent(agentUrl, info.url);
        return false;
      } catch (e) {
        console.error(`[CF] Solver failed for ${key}:`, e);
        return false;
      } finally {
        pendingSolves.delete(key);
      }
    })();

    pendingSolves.set(key, attempt);
    return attempt;
  };

  return async <T>(fn: () => T): Promise<T> => {
    let firstError: unknown;

    for (let round = 0; ; round++) {
      try {
        return await fn();
      } catch (e) {
        const isCfError = e instanceof Error && e.name === "CloudflareBlockedError";
        if (!isCfError) throw e;

        // Report the challenge that started this, not the last retry's.
        if (firstError === undefined) firstError = e;

        // No way to solve challenges - behave as if there were no retry.
        if (!solver && !agentUrl) throw firstError;

        if (round >= MAX_CF_SOLVE_ROUNDS) {
          console.log(`[CF] Giving up after ${round} solve attempts`);
          throw firstError;
        }

        const cfError = e as CloudflareBlockedError;
        const info: CloudflareChallengeInfo = {
          url: cfError.url,
          status: cfError.status,
          host: cfError.host || hostFromUrl(cfError.url),
          userAgent: cfError.userAgent,
        };

        console.log(`[CF] Challenge detected: ${cfError.url}`);
        const solved = await solveChallenge(info);
        if (!solved) {
          console.log(`[CF] Failed to solve challenge`);
          throw firstError;
        }
        console.log(`[CF] Retrying request...`);
      }
    }
  };
}

/**
 * Create async wrapper from sync source
 * Wraps all sync methods with CF retry logic
 */
export function createAsyncWrapper(
  source: AidokuSource,
  cfRetry: <T>(fn: () => T) => Promise<T>,
  onSettingsChange?: (newSettings: Record<string, unknown>) => void,
  onDispose?: () => void
): AsyncAidokuSource {
  return {
    id: source.id,
    manifest: source.manifest,
    settingsJson: source.settingsJson,

    async getSearchMangaList(query, page, filters) {
      return cfRetry(() => source.getSearchMangaList(query, page, filters));
    },

    async getMangaDetails(manga) {
      return cfRetry(() => source.getMangaDetails(manga));
    },

    async getChapterList(manga) {
      return cfRetry(() => source.getChapterList(manga));
    },

    async getPageList(manga, chapter) {
      return cfRetry(() => source.getPageList(manga, chapter));
    },

    async getFilters() {
      return cfRetry(() => source.getFilters());
    },

    async getListings() {
      // Official Aidoku: staticListings + dynamicListings (if available)
      const staticListings = source.manifest.listings ?? [];
      if (source.hasDynamicListings) {
        return cfRetry(() => [...staticListings, ...source.getListings()]);
      }
      return staticListings;
    },

    async getMangaListForListing(listing, page) {
      return cfRetry(() => source.getMangaListForListing(listing, page));
    },

    async hasListingProvider() {
      return source.hasListingProvider;
    },

    async hasHomeProvider() {
      return source.hasHome;
    },

    async hasListings() {
      const staticListings = source.manifest.listings ?? [];
      return source.hasDynamicListings || staticListings.length > 0;
    },

    async isOnlySearch() {
      const hasHome = source.hasHome;
      const staticListings = source.manifest.listings ?? [];
      const hasListings = source.hasDynamicListings || staticListings.length > 0;
      return !hasHome && !hasListings;
    },

    async handlesBasicLogin() {
      return source.handlesBasicLogin;
    },

    async handlesWebLogin() {
      return source.handlesWebLogin;
    },

    async handleBasicLogin(key, username, password) {
      return cfRetry(() => source.handleBasicLogin(key, username, password));
    },

    async handleWebLogin(key, cookies) {
      return cfRetry(() => source.handleWebLogin(key, cookies));
    },

    async handleNotification(notification) {
      return cfRetry(() => source.handleNotification(notification));
    },

    async getHome() {
      return cfRetry(() => source.getHome());
    },

    async getHomeWithPartials(onPartial: (layout: HomeLayout) => void) {
      return cfRetry(() => source.getHomeWithPartials(onPartial));
    },

    async modifyImageRequest(url, context) {
      return source.modifyImageRequest(url, context);
    },

    async hasImageProcessor() {
      return source.hasImageProcessor;
    },

    async processPageImage(imageData, context, requestUrl, requestHeaders, responseCode, responseHeaders) {
      return source.processPageImage(
        imageData,
        context,
        requestUrl,
        requestHeaders,
        responseCode,
        responseHeaders
      );
    },

    async hasCoverImageProcessor() {
      return source.hasCoverImageProcessor;
    },

    async processCoverImage(imageData, requestUrl, requestHeaders, responseCode, responseHeaders) {
      return source.processCoverImage(
        imageData,
        requestUrl,
        requestHeaders,
        responseCode,
        responseHeaders
      );
    },

    updateSettings(newSettings) {
      onSettingsChange?.(newSettings);
    },

    dispose() {
      onDispose?.();
    },
  };
}

/**
 * Create agent fetch function
 * Routes HTTP through Nemu Agent for native TLS + CF bypass
 */
export function createAgentFetch(agentUrl: string): CustomFetchFn {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }

    const body: Record<string, unknown> = {
      url,
      method: init.method || "GET",
      headers,
    };

    // Encode body as base64 if present
    if (init.body) {
      if (typeof init.body === "string") {
        body.body = btoa(init.body);
      } else if (init.body instanceof ArrayBuffer) {
        body.body = btoa(String.fromCharCode(...new Uint8Array(init.body)));
      } else if (init.body instanceof Uint8Array) {
        body.body = btoa(String.fromCharCode(...init.body));
      }
    }

    const res = await fetch(`${agentUrl}/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json() as {
      status: number;
      headers: Record<string, string>;
      body: string;
    };

    // Decode base64 body
    const bodyBytes = data.body
      ? Uint8Array.from(atob(data.body), c => c.charCodeAt(0))
      : new Uint8Array(0);

    // Normalize headers to lowercase
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.headers || {})) {
      respHeaders[k.toLowerCase()] = v;
    }

    return new Response(bodyBytes, {
      status: data.status,
      headers: respHeaders,
    });
  };
}

/**
 * Create proxy fetch function
 * Simple URL prefix rewriting for CORS bypass
 */
export function createProxyFetch(proxyUrl: string): CustomFetchFn {
  return (url: string, init: RequestInit = {}): Promise<Response> => {
    return fetch(proxyUrl + encodeURIComponent(url), init);
  };
}

/**
 * Resolve options to customFetch
 * Priority: customFetch > agentUrl > proxyUrl
 */
export function resolveCustomFetch(options: {
  customFetch?: CustomFetchFn;
  agentUrl?: string;
  proxyUrl?: string;
}): CustomFetchFn | undefined {
  if (options.customFetch) return options.customFetch;
  if (options.agentUrl) return createAgentFetch(options.agentUrl);
  // proxyUrl handled differently (URL rewrite vs fetch replacement)
  return undefined;
}
