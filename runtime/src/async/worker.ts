/**
 * Web Worker entry point for browser async runtime
 * 
 * This worker:
 * 1. Receives AIX bytes and config from main thread
 * 2. Uses sync XHR for HTTP (safe in worker)
 * 3. Exposes AidokuSource methods via Comlink
 */
import * as Comlink from "comlink";
import { createLoadSource } from "../runtime";
import { createSyncXhrBridge } from "../http/sync-xhr";
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
} from "../types";
import type { CanvasModule } from "../runtime";
import type { AidokuSource } from "../runtime";

// Browser canvas module
const browserCanvasModule: CanvasModule = {
  createCanvasImports,
  createHostImage,
  getHostImageData,
};

// Create loadSource with browser canvas
const loadSource = createLoadSource(browserCanvasModule);

/**
 * Worker-side source wrapper exposed via Comlink
 */
class WorkerSource {
  private source: (AidokuSource & { settingsJson?: unknown[] }) | null = null;
  private settings: Record<string, unknown> = {};

  /**
   * Load an Aidoku source from AIX bytes
   */
  async load(
    aixBytes: ArrayBuffer,
    sourceKey: string,
    proxyUrl: string | null,
    initialSettings: Record<string, unknown>
  ): Promise<{ success: boolean; settingsJson?: unknown[]; manifest?: SourceManifest }> {
    try {
      this.settings = initialSettings;

      // Create sync XHR bridge with optional proxy
      const httpBridge = createSyncXhrBridge({
        proxyUrl: proxyUrl 
          ? (url) => `${proxyUrl}${encodeURIComponent(url)}`
          : undefined,
      });

      // Settings getter reads from local store (updated via updateSettings)
      const settingsGetter = (key: string) => this.settings[key];

      // Load the source
      this.source = await loadSource(new Uint8Array(aixBytes), sourceKey, {
        httpBridge,
        settingsGetter,
      });

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
   */
  updateSettings(settings: Record<string, unknown>): void {
    this.settings = settings;
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
    return this.source.getListings();
  }

  getMangaListForListing(listing: Listing, page: number): MangaPageResult {
    if (!this.source) return { entries: [], hasNextPage: false };
    return this.source.getMangaListForListing(listing, page);
  }

  hasListingProvider(): boolean {
    return this.source?.hasListingProvider ?? false;
  }

  hasHomeProvider(): boolean {
    return this.source?.hasHome ?? false;
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

