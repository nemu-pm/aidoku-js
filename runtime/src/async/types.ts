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
 * Custom fetch function type
 * Used for routing HTTP through agent/extension
 */
export type CustomFetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Settings store interface
 */
export interface SettingsProvider {
  /** Get current settings values */
  get: () => Record<string, unknown>;
  /** Subscribe to settings changes */
  subscribe?: (callback: () => void) => () => void;
}

/**
 * Options for loading an async source
 */
export interface AsyncLoadOptions {
  /**
   * Custom fetch function (most flexible)
   * 
   * When provided:
   * - Browser: uses SharedArrayBuffer mode (if available)
   * - Node: routes through custom fetch
   * 
   * Takes precedence over agentUrl and proxyUrl.
   */
  customFetch?: CustomFetchFn;

  /**
   * Nemu Agent URL for HTTP requests
   * 
   * When provided, creates a customFetch that routes through the agent.
   * Agent provides native TLS fingerprint and Cloudflare bypass.
   * 
   * Example: "http://localhost:19283"
   */
  agentUrl?: string;

  /** 
   * Proxy URL base for CORS bypass
   * 
   * The source URL will be appended (URL-encoded).
   * Example: "https://cors.proxy.io/?url=" 
   */
  proxyUrl?: string;

  /**
   * Settings store interface
   */
  settings?: SettingsProvider;
}

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
  /** Has listings (static from manifest OR dynamic from WASM) */
  hasListings(): Promise<boolean>;
  /** onlySearch mode (no home AND no listings) */
  isOnlySearch(): Promise<boolean>;
  handlesBasicLogin(): Promise<boolean>;
  handlesWebLogin(): Promise<boolean>;
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
