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
import type { HomeLayout } from "../types";

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

  // Get current settings
  let currentSettings = settings?.get() ?? {};

  // Create sync HTTP bridge
  const httpBridge = createSyncNodeBridge({
    proxyUrl: proxyUrl ? (url) => `${proxyUrl}${encodeURIComponent(url)}` : undefined,
  });

  // Settings getter
  const settingsGetter = (key: string) => currentSettings[key];

  // Load source synchronously (but wrapped in async for API)
  const source = await loadSourceSync(input, sourceKey, {
    httpBridge,
    settingsGetter,
  });

  // Auto-default settings based on manifest config
  const manifest = source.manifest;
  if (manifest.config?.allowsBaseUrlSelect && manifest.info.urls?.length) {
    if (!currentSettings.url) {
      currentSettings.url = manifest.info.urls[0];
    }
  }
  if (manifest.info.languages?.length) {
    if (!currentSettings.languages) {
      // Default to first language (single select) or all (multi select)
      const selectType = manifest.config?.languageSelectType ?? "single";
      currentSettings.languages = selectType === "multi" 
        ? manifest.info.languages 
        : [manifest.info.languages[0]];
    }
  }

  source.initialize();

  // Subscribe to settings changes if available
  let unsubscribe: (() => void) | undefined;
  if (settings?.subscribe) {
    unsubscribe = settings.subscribe(() => {
      currentSettings = settings.get();
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

