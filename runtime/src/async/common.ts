/**
 * Shared utilities for async runtimes (Node and Browser)
 */
import type { SourceManifest, HomeLayout } from "../types";
import type { AidokuSource } from "../runtime";
import type { AsyncAidokuSource, CustomFetchFn } from "./types";
import { CloudflareBlockedError } from "../imports/net";
import { solveViaAgent } from "../cloudflare/agent";

/**
 * Extract default values from settings.json structure
 * Matches iOS Aidoku behavior from Source.swift
 */
export function extractSettingsDefaults(
  settingsJson: unknown[] | undefined
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  if (!settingsJson) return defaults;

  for (const item of settingsJson) {
    if (typeof item !== "object" || item === null) continue;
    const settingItem = item as Record<string, unknown>;
    
    // Handle group items (nested settings)
    if (settingItem.type === "group" && Array.isArray(settingItem.items)) {
      for (const subItem of settingItem.items) {
        if (typeof subItem !== "object" || subItem === null) continue;
        const setting = subItem as Record<string, unknown>;
        if (setting.key && setting.default !== undefined) {
          defaults[setting.key as string] = setting.default;
        }
      }
    }
    // Handle top-level items with key and default
    else if (settingItem.key && settingItem.default !== undefined) {
      defaults[settingItem.key as string] = settingItem.default;
    }
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

/**
 * Create CF retry wrapper
 * Retries failed requests after solving CF challenge via agent
 */
export function createCfRetry(
  agentUrl?: string
): <T>(fn: () => T) => Promise<T> {
  return async <T>(fn: () => T): Promise<T> => {
    try {
      return fn();
    } catch (e) {
      const isCfError = e instanceof Error && e.name === "CloudflareBlockedError";
      if (!isCfError) throw e;
      
      const cfError = e as CloudflareBlockedError;
      
      // Try agent CF bypass if available
      if (agentUrl) {
        console.log(`[Agent CF] Challenge detected: ${cfError.url}`);
        const solved = await solveViaAgent(agentUrl, cfError.url);
        if (solved) {
          console.log(`[Agent CF] Retrying request...`);
          return fn();
        }
        console.log(`[Agent CF] Failed to solve challenge`);
      }
      
      // No agent or agent failed - re-throw the error
      throw e;
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

    async getHome() {
      return cfRetry(() => source.getHome());
    },

    async getHomeWithPartials(onPartial: (layout: HomeLayout) => void) {
      return cfRetry(() => source.getHomeWithPartials(onPartial));
    },

    async modifyImageRequest(url) {
      return source.modifyImageRequest(url);
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

