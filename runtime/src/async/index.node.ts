/**
 * Node.js/Bun async runtime
 * 
 * Runs directly on main thread (no Worker needed).
 * Uses sync HTTP via child_process.
 */
import { createLoadSource, type CanvasModule, type SourceInput } from "../runtime";
import { createSyncNodeBridge } from "../http/sync-node";
import {
  createCanvasImports,
  createHostImage,
  getHostImageData,
} from "../imports/canvas.node";
import type { AsyncAidokuSource, AsyncLoadOptions } from "./types";
import type { HomeLayout, SourceManifest } from "../types";

// Re-export types
export type { AsyncAidokuSource, AsyncLoadOptions } from "./types";

// Node canvas module
const nodeCanvasModule: CanvasModule = {
  createCanvasImports,
  createHostImage,
  getHostImageData,
};

// Create sync loadSource
const loadSourceSync = createLoadSource(nodeCanvasModule);

/**
 * Extract default values from settings.json structure
 * Matches iOS Aidoku behavior from Source.swift
 */
function extractSettingsDefaults(settingsJson: unknown[] | undefined): Record<string, unknown> {
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
function applyManifestDefaults(
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
 * Load an Aidoku source asynchronously (Node.js version)
 * 
 * Runs directly on main thread using sync HTTP.
 * All methods return Promises for API consistency.
 * 
 * @param input - AIX bytes or SourceComponents
 * @param sourceKey - Unique identifier for settings/storage
 * @param options - Proxy URL and settings configuration
 */
export async function loadSource(
  input: SourceInput,
  sourceKey: string,
  options: AsyncLoadOptions = {}
): Promise<AsyncAidokuSource> {
  const { proxyUrl, settings } = options;

  // Get user settings (will be merged with defaults)
  const userSettings = settings?.get() ?? {};

  // Create sync HTTP bridge
  const httpBridge = createSyncNodeBridge({
    proxyUrl: proxyUrl ? (url) => `${proxyUrl}${encodeURIComponent(url)}` : undefined,
  });

  // Load source (but don't initialize yet - we need to extract defaults first)
  const source = await loadSourceSync(input, sourceKey, {
    httpBridge,
    // Provide a getter that will be populated with defaults before initialize()
    settingsGetter: (key: string) => currentSettings[key],
  });

  // Extract defaults from settings.json (like iOS Aidoku does)
  const settingsDefaults = extractSettingsDefaults(source.settingsJson);
  
  // Merge: settingsJson defaults < manifest defaults < user settings
  // (user settings take precedence over defaults)
  let currentSettings: Record<string, unknown> = { ...settingsDefaults };
  applyManifestDefaults(currentSettings, source.manifest);
  currentSettings = { ...currentSettings, ...userSettings };

  // Now initialize with defaults populated
  source.initialize();

  // Subscribe to settings changes if available
  // Always merge with defaults so user settings take precedence
  let unsubscribe: (() => void) | undefined;
  if (settings?.subscribe) {
    unsubscribe = settings.subscribe(() => {
      const newUserSettings = settings.get();
      // Re-apply defaults, then overlay new user settings
      currentSettings = { ...settingsDefaults };
      applyManifestDefaults(currentSettings, source.manifest);
      currentSettings = { ...currentSettings, ...newUserSettings };
    });
  }

  // Return async wrapper (methods are sync but return Promises for consistency)
  const asyncSource: AsyncAidokuSource = {
    id: source.id,
    manifest: source.manifest,
    settingsJson: source.settingsJson,

    async getSearchMangaList(query, page, filters) {
      return source.getSearchMangaList(query, page, filters);
    },

    async getMangaDetails(manga) {
      return source.getMangaDetails(manga);
    },

    async getChapterList(manga) {
      return source.getChapterList(manga);
    },

    async getPageList(manga, chapter) {
      return source.getPageList(manga, chapter);
    },

    async getFilters() {
      return source.getFilters();
    },

    async getListings() {
      // Official Aidoku: staticListings + dynamicListings (if available)
      const staticListings = source.manifest.listings ?? [];
      if (source.hasDynamicListings) {
        return [...staticListings, ...source.getListings()];
      }
      return staticListings;
    },

    async getMangaListForListing(listing, page) {
      return source.getMangaListForListing(listing, page);
    },

    async hasListingProvider() {
      // WASM provides get_manga_list (ListingProvider trait)
      return source.hasListingProvider;
    },

    async hasHomeProvider() {
      // WASM provides get_home (Home trait)
      return source.hasHome;
    },

    async hasListings() {
      // Official Aidoku: dynamicListings || staticListings.length > 0
      const staticListings = source.manifest.listings ?? [];
      return source.hasDynamicListings || staticListings.length > 0;
    },

    async isOnlySearch() {
      // Official Aidoku: !providesHome && !hasListings
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
      return source.getHome();
    },

    async getHomeWithPartials(onPartial: (layout: HomeLayout) => void) {
      return source.getHomeWithPartials(onPartial);
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
      currentSettings = newSettings;
    },

    dispose() {
      unsubscribe?.();
      // No worker to terminate in Node
    },
  };

  return asyncSource;
}

