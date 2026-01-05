/**
 * Web Worker entry point for browser async runtime
 * 
 * This worker:
 * 1. Receives AIX bytes and config from main thread
 * 2. Uses sync XHR OR SharedArrayBuffer bridge for HTTP
 * 3. Exposes AidokuSource methods via Comlink
 */
import * as Comlink from "comlink";
import { createLoadSource } from "../runtime";
import { createSyncXhrBridge } from "../http/sync-xhr";
import { createSabWorkerBridge, type SabHttpBridge } from "../http/sync-sab";
import {
  createCanvasImports,
  createHostImage,
  getHostImageData,
} from "../imports/canvas";
import type {
  Manga,
  Chapter,
  Page,
  MangaPageResult,
  Filter,
  FilterValue,
  Listing,
  SourceManifest,
  HomeLayout,
  HttpBridge,
} from "../types";
import type { CanvasModule } from "../runtime";
import type { AidokuSource } from "../runtime";
import { extractSettingsDefaults, applyManifestDefaults } from "./common";

// Browser canvas module
const browserCanvasModule: CanvasModule = {
  createCanvasImports,
  createHostImage,
  getHostImageData,
};

// Create loadSource with browser canvas
const loadSource = createLoadSource(browserCanvasModule);

// SAB bridge instance (if using SAB mode)
let sabBridge: SabHttpBridge | null = null;

/**
 * Worker-side source wrapper exposed via Comlink
 */
class WorkerSource {
  private source: AidokuSource | null = null;
  private settings: Record<string, unknown> = {};
  private settingsDefaults: Record<string, unknown> = {};

  /**
   * Load an Aidoku source from AIX bytes
   * 
   * @param sharedBuffer - If provided, use SharedArrayBuffer bridge for HTTP (extension mode)
   *                       If null, use sync XHR with proxyUrl
   */
  async load(
    aixBytes: ArrayBuffer,
    sourceKey: string,
    proxyUrl: string | null,
    initialSettings: Record<string, unknown>,
    sharedBuffer: SharedArrayBuffer | null = null
  ): Promise<{ success: boolean; settingsJson?: unknown[]; manifest?: SourceManifest }> {
    try {
      let httpBridge: HttpBridge;
      
      if (sharedBuffer) {
        // SAB mode - use SharedArrayBuffer bridge for extension proxy
        console.log("[Worker] Using SharedArrayBuffer HTTP bridge (extension mode)");
        sabBridge = createSabWorkerBridge(
          (msg) => self.postMessage(msg),
          sharedBuffer
        );
        httpBridge = sabBridge;
      } else {
        // XHR mode - use sync XHR with optional proxy
        console.log("[Worker] Using sync XHR HTTP bridge");
        httpBridge = createSyncXhrBridge({
          proxyUrl: proxyUrl 
            ? (url) => `${proxyUrl}${encodeURIComponent(url)}`
            : undefined,
        });
      }

      // Settings getter reads from local store (updated via updateSettings)
      const settingsGetter = (key: string) => this.settings[key];

      // Load the source (but don't initialize yet - we need defaults first)
      this.source = await loadSource(new Uint8Array(aixBytes), sourceKey, {
        httpBridge,
        settingsGetter,
      });

      // Extract defaults from settings.json (like iOS Aidoku does)
      this.settingsDefaults = extractSettingsDefaults(this.source.settingsJson);
      
      // Merge: settingsJson defaults < manifest defaults < user settings
      this.settings = { ...this.settingsDefaults };
      applyManifestDefaults(this.settings, this.source.manifest);
      this.settings = { ...this.settings, ...initialSettings };

      // Now initialize with defaults populated
      this.source.initialize();

      return {
        success: true,
        settingsJson: this.source.settingsJson,
        manifest: this.source.manifest,
      };
    } catch (e) {
      console.error("[Worker] Failed to load source:", e);
      return { success: false };
    }
  }

  /**
   * Update settings from main thread
   * Merges with defaults so user settings take precedence
   */
  updateSettings(newUserSettings: Record<string, unknown>): void {
    if (!this.source) return;
    this.settings = { ...this.settingsDefaults };
    applyManifestDefaults(this.settings, this.source.manifest);
    this.settings = { ...this.settings, ...newUserSettings };
  }

  // Source methods - delegate to loaded source

  getManifest(): SourceManifest | null {
    return this.source?.manifest ?? null;
  }

  getSearchMangaList(
    query: string | null,
    page: number,
    filters: FilterValue[]
  ): MangaPageResult {
    if (!this.source) return { entries: [], hasNextPage: false };
    return this.source.getSearchMangaList(query, page, filters);
  }

  getMangaDetails(manga: Manga): Manga {
    if (!this.source) return manga;
    return this.source.getMangaDetails(manga);
  }

  getChapterList(manga: Manga): Chapter[] {
    if (!this.source) return [];
    return this.source.getChapterList(manga);
  }

  getPageList(manga: Manga, chapter: Chapter): Page[] {
    if (!this.source) return [];
    return this.source.getPageList(manga, chapter);
  }

  getFilters(): Filter[] {
    if (!this.source) return [];
    return this.source.getFilters();
  }

  getListings(): Listing[] {
    if (!this.source) return [];
    // Official Aidoku: staticListings + dynamicListings (if available)
    const staticListings = this.source.manifest.listings ?? [];
    if (this.source.hasDynamicListings) {
      return [...staticListings, ...this.source.getListings()];
    }
    return staticListings;
  }

  getMangaListForListing(listing: Listing, page: number): MangaPageResult {
    if (!this.source) return { entries: [], hasNextPage: false };
    return this.source.getMangaListForListing(listing, page);
  }

  hasListingProvider(): boolean {
    // WASM provides get_manga_list (ListingProvider trait)
    return this.source?.hasListingProvider ?? false;
  }

  hasListings(): boolean {
    if (!this.source) return false;
    // Official Aidoku: dynamicListings || staticListings.length > 0
    const staticListings = this.source.manifest.listings ?? [];
    return this.source.hasDynamicListings || staticListings.length > 0;
  }

  isOnlySearch(): boolean {
    if (!this.source) return true;
    // Official Aidoku: !providesHome && !hasListings
    const hasHome = this.source.hasHome;
    const staticListings = this.source.manifest.listings ?? [];
    const hasListings = this.source.hasDynamicListings || staticListings.length > 0;
    return !hasHome && !hasListings;
  }

  hasHomeProvider(): boolean {
    return this.source?.hasHome ?? false;
  }

  handlesBasicLogin(): boolean {
    return this.source?.handlesBasicLogin ?? false;
  }

  handlesWebLogin(): boolean {
    return this.source?.handlesWebLogin ?? false;
  }

  getHome(): HomeLayout | null {
    if (!this.source) return null;
    return this.source.getHome();
  }

  getHomeWithPartials(onPartial: (layout: HomeLayout) => void): HomeLayout | null {
    if (!this.source) return null;
    return this.source.getHomeWithPartials(onPartial);
  }

  modifyImageRequest(url: string): { url: string; headers: Record<string, string> } {
    if (!this.source) return { url, headers: {} };
    return this.source.modifyImageRequest(url);
  }

  hasImageProcessor(): boolean {
    return this.source?.hasImageProcessor ?? false;
  }

  async processPageImage(
    imageData: Uint8Array,
    context: Record<string, string> | null,
    requestUrl: string,
    requestHeaders: Record<string, string>,
    responseCode: number,
    responseHeaders: Record<string, string>
  ): Promise<Uint8Array | null> {
    if (!this.source) return null;
    return this.source.processPageImage(
      imageData,
      context,
      requestUrl,
      requestHeaders,
      responseCode,
      responseHeaders
    );
  }
}

// Create and expose the worker source
const workerSource = new WorkerSource();
Comlink.expose(workerSource);

// Export type for main thread
export type WorkerSourceApi = WorkerSource;
