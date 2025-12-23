/**
 * Async runtime types
 */
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

/**
 * Async Aidoku source interface
 * All methods return Promises for use on main thread
 */
export interface AsyncAidokuSource {
  readonly id: string;
  readonly manifest: SourceManifest;
  /** Raw settings.json from AIX package */
  readonly settingsJson?: unknown[];

  getSearchMangaList(
    query: string | null,
    page: number,
    filters: FilterValue[]
  ): Promise<MangaPageResult>;

  getMangaDetails(manga: Manga): Promise<Manga>;
  getChapterList(manga: Manga): Promise<Chapter[]>;
  getPageList(manga: Manga, chapter: Chapter): Promise<Page[]>;
  getFilters(): Promise<Filter[]>;
  getListings(): Promise<Listing[]>;
  getMangaListForListing(listing: Listing, page: number): Promise<MangaPageResult>;
  hasListingProvider(): Promise<boolean>;
  hasHomeProvider(): Promise<boolean>;
  getHome(): Promise<HomeLayout | null>;
  getHomeWithPartials(onPartial: (layout: HomeLayout) => void): Promise<HomeLayout | null>;
  
  modifyImageRequest(url: string): Promise<{ url: string; headers: Record<string, string> }>;
  hasImageProcessor(): Promise<boolean>;
  processPageImage(
    imageData: Uint8Array,
    context: Record<string, string> | null,
    requestUrl: string,
    requestHeaders: Record<string, string>,
    responseCode: number,
    responseHeaders: Record<string, string>
  ): Promise<Uint8Array | null>;

  /** Update settings (triggers re-read on next WASM call) */
  updateSettings(settings: Record<string, unknown>): void;

  /** Terminate the source and release resources */
  dispose(): void;
}

/**
 * Options for loading an async source
 */
export interface AsyncLoadOptions {
  /** 
   * Proxy URL base for CORS bypass
   * The source URL will be appended (URL-encoded)
   * Example: "https://cors.proxy.io/?url=" 
   */
  proxyUrl?: string;

  /**
   * Settings store interface
   */
  settings?: {
    /** Get current settings values */
    get: () => Record<string, unknown>;
    /** Subscribe to settings changes */
    subscribe?: (callback: () => void) => () => void;
  };
}

