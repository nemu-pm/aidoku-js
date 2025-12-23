/**
 * Browser async runtime
 * 
 * Creates a Web Worker internally, exposes clean async API.
 * Consumer doesn't need to manage workers.
 */
import * as Comlink from "comlink";
import type { WorkerSourceApi } from "./worker";
import type { AsyncAidokuSource, AsyncLoadOptions } from "./types";
import type { SourceManifest, HomeLayout } from "../types";
import type { SourceInput } from "../runtime";
import { isAixPackage } from "../aix";

// Re-export types
export type { AsyncAidokuSource, AsyncLoadOptions } from "./types";

/**
 * Load an Aidoku source asynchronously (browser version)
 * 
 * Creates a Web Worker internally to handle sync HTTP.
 * All methods return Promises.
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

  // Convert input to AIX bytes if needed
  let aixBytes: ArrayBuffer;
  if (input instanceof ArrayBuffer) {
    aixBytes = input;
  } else if (input instanceof Uint8Array) {
    // Create a proper ArrayBuffer copy
    aixBytes = new Uint8Array(input).buffer as ArrayBuffer;
  } else {
    // SourceComponents - need to pass through (worker will handle)
    // For now, throw - we expect AIX bytes in browser
    throw new Error("Browser async runtime requires AIX bytes, not SourceComponents");
  }

  // Validate it's an AIX package
  if (!isAixPackage(aixBytes)) {
    throw new Error("Invalid input: expected AIX package bytes");
  }

  // Create worker using standard URL pattern
  // Bundlers (Vite, webpack, esbuild) handle this automatically
  const worker = new Worker(
    new URL("./worker.js", import.meta.url),
    { type: "module" }
  );

  // Wrap with Comlink
  const workerSource = Comlink.wrap<WorkerSourceApi>(worker);

  // Get initial settings
  const initialSettings = settings?.get() ?? {};

  // Load source in worker
  const result = await workerSource.load(
    Comlink.transfer(aixBytes, [aixBytes]),
    sourceKey,
    proxyUrl ?? null,
    initialSettings
  );

  if (!result.success || !result.manifest) {
    worker.terminate();
    throw new Error(`Failed to load source: ${sourceKey}`);
  }

  const manifest = result.manifest;
  const settingsJson = result.settingsJson;

  // Subscribe to settings changes if available
  let unsubscribe: (() => void) | undefined;
  if (settings?.subscribe) {
    unsubscribe = settings.subscribe(() => {
      const newSettings = settings.get();
      workerSource.updateSettings(newSettings);
    });
  }

  // Return async wrapper
  const source: AsyncAidokuSource = {
    id: manifest.info.id,
    manifest,
    settingsJson,

    async getSearchMangaList(query, page, filters) {
      return workerSource.getSearchMangaList(query, page, filters);
    },

    async getMangaDetails(manga) {
      return workerSource.getMangaDetails(manga);
    },

    async getChapterList(manga) {
      return workerSource.getChapterList(manga);
    },

    async getPageList(manga, chapter) {
      return workerSource.getPageList(manga, chapter);
    },

    async getFilters() {
      return workerSource.getFilters();
    },

    async getListings() {
      return workerSource.getListings();
    },

    async getMangaListForListing(listing, page) {
      return workerSource.getMangaListForListing(listing, page);
    },

    async hasListingProvider() {
      return workerSource.hasListingProvider();
    },

    async hasHomeProvider() {
      return workerSource.hasHomeProvider();
    },

    async getHome() {
      return workerSource.getHome();
    },

    async getHomeWithPartials(onPartial: (layout: HomeLayout) => void) {
      // Note: Comlink can proxy callbacks, but for simplicity we call without partials
      // TODO: Implement proper partial streaming via Comlink.proxy
      return workerSource.getHomeWithPartials(Comlink.proxy(onPartial));
    },

    async modifyImageRequest(url) {
      return workerSource.modifyImageRequest(url);
    },

    async hasImageProcessor() {
      return workerSource.hasImageProcessor();
    },

    async processPageImage(imageData, context, requestUrl, requestHeaders, responseCode, responseHeaders) {
      return workerSource.processPageImage(
        imageData,
        context,
        requestUrl,
        requestHeaders,
        responseCode,
        responseHeaders
      );
    },

    updateSettings(newSettings) {
      workerSource.updateSettings(newSettings);
    },

    dispose() {
      unsubscribe?.();
      worker.terminate();
    },
  };

  return source;
}

