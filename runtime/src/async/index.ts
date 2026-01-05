/**
 * Browser async runtime
 * 
 * Creates a Web Worker internally, exposes clean async API.
 * Supports two HTTP modes:
 * - XHR mode: Worker uses sync XHR to proxy URL (default)
 * - SAB mode: Worker uses SharedArrayBuffer, main thread routes HTTP through custom fetch
 */
import * as Comlink from "comlink";
import type { WorkerSourceApi } from "./worker";
import type { AsyncAidokuSource, AsyncLoadOptions, CustomFetchFn } from "./types";
import type { SourceManifest, HomeLayout } from "../types";
import type { SourceInput } from "../runtime";
import { isAixPackage } from "../aix";
import { 
  createSabMainThreadHandler, 
  createSabBuffer,
  isSharedArrayBufferAvailable,
  type SabHttpRequest,
} from "../http/sync-sab";
import { createAgentFetch } from "./common";

// Re-export types
export type { AsyncAidokuSource, AsyncLoadOptions, CustomFetchFn } from "./types";
export { isSharedArrayBufferAvailable } from "../http/sync-sab";

/**
 * Load an Aidoku source asynchronously (browser version)
 * 
 * Creates a Web Worker internally to handle sync HTTP.
 * All methods return Promises.
 * 
 * @param input - AIX bytes or SourceComponents
 * @param sourceKey - Unique identifier for settings/storage
 * @param options - Proxy URL, agent URL, settings, and optional custom fetch for SAB mode
 */
export async function loadSource(
  input: SourceInput,
  sourceKey: string,
  options: AsyncLoadOptions = {}
): Promise<AsyncAidokuSource> {
  const { proxyUrl, agentUrl, settings } = options;
  
  // Resolve customFetch: explicit > agentUrl > undefined
  let customFetch: CustomFetchFn | undefined = options.customFetch;
  if (!customFetch && agentUrl) {
    customFetch = createAgentFetch(agentUrl);
    console.log(`[Aidoku] 🚀 Agent detected - using native TLS`);
  }

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

  // Decide whether to use SAB mode
  const useSabMode = customFetch && isSharedArrayBufferAvailable();
  
  // Create SharedArrayBuffer for data exchange if using SAB mode
  let sharedBuffer: SharedArrayBuffer | null = null;
  if (useSabMode) {
    sharedBuffer = createSabBuffer(); // 10MB buffer for response data
    console.log("[Aidoku] ✅ SharedArrayBuffer mode active - HTTP routed through extension");
  } else if (customFetch && !isSharedArrayBufferAvailable()) {
    console.warn("[Aidoku] ⚠️ Extension available but SharedArrayBuffer not supported - falling back to proxy");
  }

  // Create worker using standard URL pattern
  // Bundlers (Vite, webpack, esbuild) handle this automatically
  const worker = new Worker(
    new URL("./worker.js", import.meta.url),
    { type: "module" }
  );

  // Set up SAB mode handler if using custom fetch
  let sabHandler: ((msg: SabHttpRequest) => Promise<void>) | null = null;
  
  if (useSabMode && sharedBuffer && customFetch) {
    // Create handler that routes HTTP through customFetch
    // Response data is written directly to SharedArrayBuffer
    sabHandler = createSabMainThreadHandler(customFetch, sharedBuffer);
    
    // Listen for HTTP requests from worker
    worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg?.type === "HTTP_REQUEST") {
        sabHandler!(msg as SabHttpRequest);
      }
    });
  }

  // Wrap with Comlink
  const workerSource = Comlink.wrap<WorkerSourceApi>(worker);

  // Get initial settings
  const initialSettings = settings?.get() ?? {};

  // Load source in worker
  // Pass sharedBuffer if using SAB mode
  const result = await workerSource.load(
    Comlink.transfer(aixBytes, [aixBytes]),
    sourceKey,
    useSabMode ? null : (proxyUrl ?? null), // Don't use proxyUrl in SAB mode
    initialSettings,
    sharedBuffer // Will be null if not using SAB mode
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

    async hasListings() {
      return workerSource.hasListings();
    },

    async isOnlySearch() {
      return workerSource.isOnlySearch();
    },

    async handlesBasicLogin() {
      return workerSource.handlesBasicLogin();
    },

    async handlesWebLogin() {
      return workerSource.handlesWebLogin();
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
