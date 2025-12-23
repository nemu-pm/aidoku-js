/**
 * Aidoku WASM Runtime - loads and executes Aidoku source modules
 */
import { GlobalStore } from "./global-store";
import type {
  Manga,
  Chapter,
  Page,
  MangaPageResult,
  Filter,
  FilterValue,
  SourceManifest,
  MangaStatus,
  ContentRating,
  Viewer,
  GenreState,
  Listing,
  HomeLayout,
  HomeComponent,
  HttpBridge,
} from "./types";
import { FilterType } from "./types";
import {
  createStdImports,
  createNetImports,
  createHtmlImports,
  createJsonImports,
  createDefaultsImports,
  createEnvImports,
  createAidokuImports,
  createJsImports,
  type SettingsGetter,
  type SettingsSetter,
} from "./imports";
import { extractAix, isAixPackage, type AixContents } from "./aix";

// Canvas module types for injection
export interface CanvasModule {
  createCanvasImports: (store: GlobalStore) => WebAssembly.ModuleImports;
  createHostImage: (
    store: GlobalStore,
    imageData: Uint8Array
  ) => Promise<{ rid: number; width: number; height: number } | null>;
  getHostImageData: (store: GlobalStore, rid: number) => Uint8Array | null;
}
import {
  encodeString,
  encodeEmptyVec,
  encodeManga,
  encodeChapter,
  encodeImageResponse,
  encodeHashMap,
  encodeFilterValues,
  decodeMangaPageResult,
  decodeManga,
  decodePageList,
  decodeFilterList,
  decodeString,
  decodeVec,
  concatBytes,
  decodeHomeLayout,
  decodeHomeComponent,
  type DecodedManga,
  type DecodedFilter,
} from "./postcard";
import {
  readResultPayload,
  decodeRidFromPayload,
  RuntimeMode,
  detectRuntimeMode,
} from "./result-decoder";

export interface AidokuSource {
  id: string;
  manifest: SourceManifest;
  /** Runtime mode: legacy (Swift-era) or aidoku-rs (modern) */
  mode: RuntimeMode;
  /** Whether this source has a page image processor (for descrambling) */
  hasImageProcessor: boolean;
  /** Whether this source provides custom image requests */
  hasImageRequestProvider: boolean;
  /** Whether this source provides a home layout */
  hasHome: boolean;
  /** Whether this source provides listing-based browsing */
  hasListingProvider: boolean;
  /** Whether this source provides dynamic listings */
  hasDynamicListings: boolean;
  initialize(): void;
  getSearchMangaList(query: string | null, page: number, filters: FilterValue[]): MangaPageResult;
  getMangaDetails(manga: Manga): Manga;
  getChapterList(manga: Manga): Chapter[];
  getPageList(manga: Manga, chapter: Chapter): Page[];
  getFilters(): Filter[];
  /** Get manga list for a specific listing (for ListingProvider sources) */
  getMangaListForListing(listing: Listing, page: number): MangaPageResult;
  /** Get home layout (for Home sources) */
  getHome(): HomeLayout | null;
  /** Get home layout with progressive partial updates (for Home sources) */
  getHomeWithPartials(onPartial: (layout: HomeLayout) => void): HomeLayout | null;
  /** Get dynamic listings (for DynamicListings sources) */
  getListings(): Listing[];
  modifyImageRequest(
    url: string,
    context?: Record<string, string> | null
  ): { url: string; headers: Record<string, string> };
  /**
   * Process a page image (e.g., descramble).
   * Only works if hasImageProcessor is true.
   */
  processPageImage(
    imageData: Uint8Array,
    context: Record<string, string> | null,
    requestUrl: string,
    requestHeaders: Record<string, string>,
    responseCode: number,
    responseHeaders: Record<string, string>
  ): Promise<Uint8Array | null>;
}

export interface AidokuRuntimeOptions {
  /** HTTP bridge for making network requests */
  httpBridge: HttpBridge;
  /** Function to get settings values */
  settingsGetter?: SettingsGetter;
  /** Function to persist settings values */
  settingsSetter?: SettingsSetter;
  /** Canvas module for image operations (auto-detected, but can be overridden) */
  canvasModule?: CanvasModule;
}

/**
 * Pre-extracted source components (for advanced use cases)
 */
export interface SourceComponents {
  wasmBytes: Uint8Array | ArrayBuffer;
  /** Parsed source.json manifest */
  manifest: SourceManifest;
  /** Raw settings.json (optional) */
  settingsJson?: unknown[];
  /** Raw filters.json (optional, merged into manifest if manifest.filters is empty) */
  filtersJson?: unknown[];
}

/**
 * Input types for loadSource:
 * - ArrayBuffer/Uint8Array: AIX package bytes (auto-extracted)
 * - SourceComponents: Pre-extracted components
 * - string: URL to WASM file (legacy, requires manifest parameter)
 */
export type SourceInput = ArrayBuffer | Uint8Array | SourceComponents;

/**
 * Create a loadSource function with a specific canvas module.
 * This is used internally by index.ts and index.node.ts to provide auto-detection.
 */
export function createLoadSource(defaultCanvasModule: CanvasModule) {
  /**
   * Load an Aidoku WASM source
   * @param input - AIX bytes, pre-extracted components, or URL to WASM
   * @param sourceKey - Unique identifier for settings/storage (e.g., "registryId:sourceId")
   * @param options - Runtime options including HttpBridge
   */
  return async function loadSource(
    input: SourceInput,
    sourceKey: string,
    options: AidokuRuntimeOptions
  ): Promise<AidokuSource & { settingsJson?: unknown[] }> {
    const { httpBridge, settingsGetter = () => undefined, settingsSetter, canvasModule = defaultCanvasModule } = options;
    const { createCanvasImports, createHostImage, getHostImageData } = canvasModule;
    const store = new GlobalStore(sourceKey);

  // Extract source components
  let wasmBytes: Uint8Array;
  let manifest: SourceManifest;
  let settingsJson: unknown[] | undefined;

  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    // Binary data - check if it's AIX or raw WASM
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (isAixPackage(bytes)) {
      // AIX package - extract
      const aix = extractAix(bytes);
      wasmBytes = aix.wasmBytes;
      manifest = aix.manifest;
      settingsJson = aix.settingsJson;
    } else {
      throw new Error("Raw WASM bytes require SourceComponents with manifest");
    }
  } else {
    // SourceComponents object
    wasmBytes = input.wasmBytes instanceof Uint8Array 
      ? input.wasmBytes 
      : new Uint8Array(input.wasmBytes);
    manifest = input.manifest;
    settingsJson = input.settingsJson;
    
    // Merge filters if needed
    if (!manifest.filters && input.filtersJson) {
      manifest = { ...manifest, filters: input.filtersJson as SourceManifest["filters"] };
    }
  }

  // Create import object with all namespaces
  const importObject: WebAssembly.Imports = {
    env: createEnvImports(store),
    std: createStdImports(store),
    net: createNetImports(store, httpBridge),
    html: createHtmlImports(store),
    json: createJsonImports(store),
    defaults: createDefaultsImports(store, settingsGetter, settingsSetter),
    aidoku: createAidokuImports(store),
    canvas: createCanvasImports(store),
    js: createJsImports(store),
  };

  // Compile and instantiate WASM module
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, importObject);

  // Get memory and set it in the store
  const memory = instance.exports.memory as WebAssembly.Memory;
  store.setMemory(memory);

  // Get exported functions
  const exports = instance.exports as Record<string, WebAssembly.ExportValue>;

  // Detect runtime mode
  const mode = detectRuntimeMode(exports);
  const isNewAbi = mode === RuntimeMode.AidokuRs;

  // NEW ABI exports
  const start = exports.start as (() => void) | undefined;
  const getSearchMangaList = exports.get_search_manga_list as
    | ((queryDescriptor: number, page: number, filtersDescriptor: number) => number)
    | undefined;
  const getMangaUpdate = exports.get_manga_update as
    | ((mangaDescriptor: number, needsDetails: number, needsChapters: number) => number)
    | undefined;
  const getImageRequest = exports.get_image_request as
    | ((urlDescriptor: number, contextDescriptor: number) => number)
    | undefined;
  const processPageImageExport = exports.process_page_image as
    | ((responseDescriptor: number, contextDescriptor: number) => number)
    | undefined;
  const getFilterList = exports.get_filters as (() => number) | undefined;
  const freeResult = exports.free_result as ((ptr: number) => void) | undefined;
  const getHome = exports.get_home as (() => number) | undefined;
  const getMangaList = exports.get_manga_list as
    | ((listingDescriptor: number, page: number) => number)
    | undefined;
  const getListings = exports.get_listings as (() => number) | undefined;

  // OLD ABI exports
  const oldGetMangaList = exports.get_manga_list as
    | ((filterDescriptor: number, page: number) => number)
    | undefined;
  const oldGetMangaDetails = exports.get_manga_details as
    | ((mangaDescriptor: number) => number)
    | undefined;
  const oldGetChapterList = exports.get_chapter_list as
    | ((mangaDescriptor: number) => number)
    | undefined;
  const oldGetPageList = exports.get_page_list as
    | ((chapterDescriptor: number) => number)
    | undefined;
  const oldModifyImageRequest = exports.modify_image_request as
    | ((requestDescriptor: number) => void)
    | undefined;

  // get_page_list with different signatures
  const wasmGetPageList = isNewAbi
    ? (exports.get_page_list as
        | ((mangaDescriptor: number, chapterDescriptor: number) => number)
        | undefined)
    : undefined;

  // Helper to read postcard result from WASM memory
  function readResult(ptr: number): Uint8Array | null {
    if (ptr <= 0) return null;

    try {
      const view = new DataView(memory.buffer);
      const len = view.getInt32(ptr, true);
      if (len <= 8) return null;
      const data = new Uint8Array(memory.buffer, ptr + 8, len - 8);
      return data.slice();
    } catch {
      return null;
    }
  }

  // Helper to convert decoded filter to Filter type
  function convertDecodedFilter(decoded: DecodedFilter): Filter {
    switch (decoded.type) {
      case FilterType.Title:
        return { type: FilterType.Title, name: decoded.name };
      case FilterType.Author:
        return { type: FilterType.Author, name: decoded.name };
      case FilterType.Select:
        return {
          type: FilterType.Select,
          name: decoded.name,
          options: decoded.options || [],
          default: typeof decoded.default === "number" ? decoded.default : 0,
        };
      case FilterType.Sort:
        return {
          type: FilterType.Sort,
          name: decoded.name,
          options: decoded.options || [],
          default:
            typeof decoded.default === "object" && "ascending" in (decoded.default as object)
              ? (decoded.default as { index: number; ascending: boolean })
              : { index: 0, ascending: false },
          canAscend: decoded.canAscend ?? false,
        };
      case FilterType.Check:
        return {
          type: FilterType.Check,
          name: decoded.name,
          default: typeof decoded.default === "boolean" ? decoded.default : false,
        };
      case FilterType.Group:
        return {
          type: FilterType.Group,
          name: decoded.name,
          filters: (decoded.filters || []).map(convertDecodedFilter),
        };
      case FilterType.Genre:
        return {
          type: FilterType.Genre,
          name: decoded.name,
          options: decoded.options || [],
          canExclude: decoded.canExclude ?? false,
          default: Array.isArray(decoded.default)
            ? decoded.default.map((g) => ({ index: g.index, state: g.state as GenreState }))
            : [],
        };
      default:
        return { type: FilterType.Title, name: decoded.name };
    }
  }

  // Implementation of getHome with optional partial streaming callback
  function getHomeImpl(onPartial: (layout: HomeLayout) => void): HomeLayout | null {
    if (!getHome) return null;

    try {
      // Clear any previous partial results
      store.partialHomeResultBytes = [];

      // Accumulated components map (keyed by title for deduplication)
      const partialComponentsMap = new Map<string, HomeComponent>();

      // Set up callback to stream partials to caller
      store.onPartialHomeBytes = (partialBytes: Uint8Array) => {
        try {
          if (partialBytes && partialBytes.length > 0) {
            // HomePartialResult is an enum: Layout=0, Component=1
            const variant = partialBytes[0];
            if (variant === 0) {
              // Layout - decode full layout (skip the variant byte)
              const layout = decodeHomeLayout(partialBytes.slice(1), manifest.info.id);
              for (const component of layout.components) {
                const key = component.title ?? `_idx_${partialComponentsMap.size}`;
                partialComponentsMap.set(key, component);
              }
            } else if (variant === 1) {
              // Component - decode single component (skip the variant byte)
              const [component] = decodeHomeComponent(partialBytes, 1, manifest.info.id);
              const key = component.title ?? `_idx_${partialComponentsMap.size}`;
              partialComponentsMap.set(key, component);
            }

            // Emit accumulated layout to caller (Swift behavior: each partial contains all so far)
            const accumulatedComponents = Array.from(partialComponentsMap.values());
            if (accumulatedComponents.length > 0) {
              onPartial({ components: accumulatedComponents });
            }
          }
        } catch (e) {
          console.warn("[Aidoku] Failed to decode partial result:", e);
        }
      };

      // Call WASM getHome - this will trigger onPartialHomeBytes callbacks synchronously
      const resultPtr = getHome();
      const resultBytes = readResult(resultPtr);

      if (freeResult && resultPtr > 0) {
        freeResult(resultPtr);
      }

      // Clean up callback
      store.onPartialHomeBytes = null;
      store.partialHomeResultBytes = [];

      // Convert map to array (order preserved as insertion order)
      const partialComponents = Array.from(partialComponentsMap.values());

      // Decode final result
      let finalLayout: HomeLayout = { components: [] };
      if (resultBytes && resultBytes.length > 0) {
        finalLayout = decodeHomeLayout(resultBytes, manifest.info.id);
      }

      // Merge: partial components have priority (they're the actual content)
      if (partialComponents.length > 0) {
        return { components: partialComponents };
      }

      return finalLayout.components.length > 0 ? finalLayout : null;
    } catch (e) {
      console.error("[Aidoku] getHome error:", e);
      store.onPartialHomeBytes = null;
      return null;
    }
  }

  return {
    id: manifest.info.id,
    manifest,
    mode,
    settingsJson,
    hasImageProcessor: !!processPageImageExport,
    hasImageRequestProvider: !!getImageRequest,
    hasHome: !!getHome,
    hasListingProvider: !!getMangaList && isNewAbi,
    hasDynamicListings: !!getListings,

    initialize() {
      if (start) {
        try {
          start();
        } catch (e) {
          console.error("[Aidoku] Initialize error:", e);
        }
      }
    },

    getSearchMangaList(
      query: string | null,
      page: number,
      filters: FilterValue[]
    ): MangaPageResult {
      // OLD ABI
      if (!isNewAbi && oldGetMangaList) {
        const scope = store.createScope();
        try {
          const SwiftFilterType = {
            base: 0,
            group: 1,
            text: 2,
            check: 3,
            select: 4,
            sort: 5,
            sortSelection: 6,
            title: 7,
            author: 8,
            genre: 9,
          };

          const convertToSwiftFilter = (f: FilterValue): unknown => {
            switch (f.type) {
              case FilterType.Title:
                return { type: SwiftFilterType.title, name: f.name || "Title", value: f.value };
              case FilterType.Author:
                return { type: SwiftFilterType.author, name: f.name || "Author", value: f.value };
              case FilterType.Select:
                return { type: SwiftFilterType.select, name: f.name, value: f.value };
              case FilterType.Sort:
                return { type: SwiftFilterType.sort, name: f.name, value: f.value };
              case FilterType.Check:
                return { type: SwiftFilterType.check, name: f.name, value: f.value };
              case FilterType.Group:
                return {
                  type: SwiftFilterType.group,
                  name: f.name,
                  filters: f.filters ? f.filters.map(convertToSwiftFilter) : [],
                };
              case FilterType.Genre:
                return { type: SwiftFilterType.genre, name: f.name, value: f.value };
              default:
                return { type: SwiftFilterType.base, name: f.name, value: f.value };
            }
          };

          const swiftFilters: unknown[] = filters.map(convertToSwiftFilter);

          if (query !== null && query !== "" && !filters.some((f) => f.type === FilterType.Title)) {
            swiftFilters.unshift({ type: SwiftFilterType.title, name: "Title", value: query });
          }

          const filtersDescriptor = scope.storeValue(swiftFilters);
          const resultDescriptor = oldGetMangaList(filtersDescriptor, page);

          if (resultDescriptor < 0) {
            return { entries: [], hasNextPage: false };
          }

          const result = store.readStdValue(resultDescriptor) as {
            entries?: unknown[];
            hasNextPage?: boolean;
          } | null;
          store.removeStdValue(resultDescriptor);

          if (!result) {
            return { entries: [], hasNextPage: false };
          }

          const mangaArray = result.entries || [];
          const entries: Manga[] = mangaArray.map((m: unknown) => {
            const manga = m as Record<string, unknown>;
            return {
              sourceId: manifest.info.id,
              id: String(manga.key || manga.id || ""),
              key: String(manga.key || manga.id || ""),
              title: manga.title as string | undefined,
              authors: manga.author
                ? [manga.author as string]
                : (manga.authors as string[] | undefined),
              artists: manga.artist
                ? [manga.artist as string]
                : (manga.artists as string[] | undefined),
              description: manga.description as string | undefined,
              tags: manga.tags as string[] | undefined,
              cover: manga.cover as string | undefined,
              url: manga.url as string | undefined,
              status: manga.status as MangaStatus | undefined,
              nsfw: (manga.nsfw ?? manga.contentRating) as ContentRating | undefined,
              viewer: manga.viewer as Viewer | undefined,
            };
          });

          return { entries, hasNextPage: result.hasNextPage ?? false };
        } catch (e) {
          console.error("[Aidoku] OLD ABI getSearchMangaList error:", e);
          return { entries: [], hasNextPage: false };
        } finally {
          scope.cleanup();
        }
      }

      // NEW ABI
      if (!getSearchMangaList) {
        return { entries: [], hasNextPage: false };
      }

      const scope = store.createScope();
      try {
        let queryDescriptor = -1;
        if (query !== null && query !== "") {
          const queryBytes = new TextEncoder().encode(query);
          queryDescriptor = scope.storeValue(queryBytes);
        }

        const filtersBytes = filters.length > 0 ? encodeFilterValues(filters) : encodeEmptyVec();
        const filtersDescriptor = scope.storeValue(filtersBytes);

        const resultPtr = getSearchMangaList(queryDescriptor, page, filtersDescriptor);
        const resultBytes = readResult(resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!resultBytes) {
          return { entries: [], hasNextPage: false };
        }

        const decoded = decodeMangaPageResult(resultBytes);
        const entries: Manga[] = decoded.entries.map((m: DecodedManga) => ({
          sourceId: manifest.info.id,
          id: m.key,
          key: m.key,
          title: m.title || undefined,
          authors: m.authors || undefined,
          artists: m.artists || undefined,
          description: m.description || undefined,
          tags: m.tags || undefined,
          cover: m.cover || undefined,
          url: m.url || undefined,
          status: m.status as MangaStatus | undefined,
          nsfw: m.contentRating as ContentRating | undefined,
          viewer: m.viewer as Viewer | undefined,
        }));

        return { entries, hasNextPage: decoded.hasNextPage };
      } catch (e) {
        console.error("[Aidoku] getSearchMangaList error:", e);
        return { entries: [], hasNextPage: false };
      } finally {
        scope.cleanup();
      }
    },

    getMangaDetails(manga: Manga): Manga {
      // OLD ABI
      if (!isNewAbi && oldGetMangaDetails) {
        const scope = store.createScope();
        try {
          const mangaObj = {
            key: manga.key,
            id: manga.id ?? manga.key,
            title: manga.title,
            cover: manga.cover,
            author: manga.authors?.[0],
            artist: manga.artists?.[0],
            description: manga.description,
            url: manga.url,
            status: manga.status,
            nsfw: manga.nsfw,
            viewer: manga.viewer,
            tags: manga.tags,
          };
          const mangaDescriptor = scope.storeValue(mangaObj);
          const resultDescriptor = oldGetMangaDetails(mangaDescriptor);

          if (resultDescriptor < 0) return manga;

          const result = store.readStdValue(resultDescriptor) as Record<string, unknown> | null;
          store.removeStdValue(resultDescriptor);

          if (!result) return manga;

          return {
            sourceId: manifest.info.id,
            id: String(result.key || result.id || manga.id),
            key: String(result.key || result.id || manga.key),
            title: (result.title as string) || manga.title,
            authors: result.author
              ? [result.author as string]
              : (result.authors as string[]) || manga.authors,
            artists: result.artist
              ? [result.artist as string]
              : (result.artists as string[]) || manga.artists,
            description: (result.description as string) || manga.description,
            tags: (result.tags as string[]) || manga.tags,
            cover: (result.cover as string) || manga.cover,
            url: (result.url as string) || manga.url,
            status: (result.status as MangaStatus) ?? manga.status,
            nsfw: ((result.nsfw ?? result.contentRating) as ContentRating) ?? manga.nsfw,
            viewer: (result.viewer as Viewer) ?? manga.viewer,
          };
        } catch (e) {
          console.error("[Aidoku] OLD ABI getMangaDetails error:", e);
          return manga;
        } finally {
          scope.cleanup();
        }
      }

      // NEW ABI
      if (!getMangaUpdate) return manga;

      const scope = store.createScope();
      try {
        const mangaBytes = encodeManga(manga);
        const mangaDescriptor = scope.storeValue(mangaBytes);

        const resultPtr = getMangaUpdate(mangaDescriptor, 1, 0);
        const resultBytes = readResult(resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!resultBytes) return manga;

        const [decoded] = decodeManga(resultBytes, 0);
        return {
          sourceId: manifest.info.id,
          id: decoded.key,
          key: decoded.key,
          title: decoded.title || undefined,
          authors: decoded.authors || undefined,
          artists: decoded.artists || undefined,
          description: decoded.description || undefined,
          tags: decoded.tags || undefined,
          cover: decoded.cover || undefined,
          url: decoded.url || undefined,
          status: decoded.status as MangaStatus | undefined,
          nsfw: decoded.contentRating as ContentRating | undefined,
          viewer: decoded.viewer as Viewer | undefined,
        };
      } catch (e) {
        console.error("[Aidoku] getMangaDetails error:", e);
        return manga;
      } finally {
        scope.cleanup();
      }
    },

    getChapterList(manga: Manga): Chapter[] {
      // OLD ABI
      if (!isNewAbi && oldGetChapterList) {
        const scope = store.createScope();
        try {
          const mangaObj = {
            key: manga.key,
            id: manga.id ?? manga.key,
            title: manga.title,
            cover: manga.cover,
          };
          const mangaDescriptor = scope.storeValue(mangaObj);
          const resultDescriptor = oldGetChapterList(mangaDescriptor);

          if (resultDescriptor < 0) return [];

          const chapters = store.readStdValue(resultDescriptor) as unknown[] | null;
          store.removeStdValue(resultDescriptor);

          if (!chapters || !Array.isArray(chapters)) return [];

          return chapters.map((c, index) => {
            const chapter = c as Record<string, unknown>;
            return {
              sourceId: manifest.info.id,
              id: String(chapter.key || chapter.id || ""),
              key: String(chapter.key || chapter.id || ""),
              mangaId: manga.key,
              title: chapter.title as string | undefined,
              chapterNumber: chapter.chapter as number | undefined,
              volumeNumber: chapter.volume as number | undefined,
              dateUploaded: chapter.dateUploaded
                ? (chapter.dateUploaded as number) * 1000
                : undefined,
              scanlator: chapter.scanlator as string | undefined,
              url: chapter.url as string | undefined,
              lang: chapter.lang as string | undefined,
              sourceOrder: index,
              locked: chapter.locked as boolean | undefined,
            };
          });
        } catch (e) {
          console.error("[Aidoku] OLD ABI getChapterList error:", e);
          return [];
        } finally {
          scope.cleanup();
        }
      }

      // NEW ABI
      if (!getMangaUpdate) return [];

      const scope = store.createScope();
      try {
        const mangaBytes = encodeManga(manga);
        const mangaDescriptor = scope.storeValue(mangaBytes);

        const resultPtr = getMangaUpdate(mangaDescriptor, 0, 1);
        const resultBytes = readResult(resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!resultBytes) return [];

        const [decoded] = decodeManga(resultBytes, 0);

        if (!decoded.chapters) return [];

        return decoded.chapters.map((c, index) => ({
          sourceId: manifest.info.id,
          id: c.key,
          key: c.key,
          mangaId: manga.key,
          title: c.title || undefined,
          chapterNumber: c.chapterNumber ?? undefined,
          volumeNumber: c.volumeNumber ?? undefined,
          dateUploaded: c.dateUploaded ? c.dateUploaded * 1000 : undefined,
          scanlator: c.scanlators?.join(", ") || undefined,
          url: c.url || undefined,
          lang: c.language || undefined,
          sourceOrder: index,
          locked: c.locked || undefined,
        }));
      } catch (e) {
        console.error("[Aidoku] getChapterList error:", e);
        return [];
      } finally {
        scope.cleanup();
      }
    },

    getPageList(manga: Manga, chapter: Chapter): Page[] {
      // OLD ABI
      if (!isNewAbi && oldGetPageList) {
        const scope = store.createScope();
        try {
          const chapterObj = {
            key: chapter.key,
            id: chapter.id ?? chapter.key,
            mangaId: manga.id ?? manga.key,
            title: chapter.title,
            chapter: chapter.chapterNumber,
            volume: chapter.volumeNumber,
          };
          const chapterDescriptor = scope.storeValue(chapterObj);
          const resultDescriptor = oldGetPageList(chapterDescriptor);

          if (resultDescriptor < 0) return [];

          const pages = store.readStdValue(resultDescriptor) as unknown[] | null;
          store.removeStdValue(resultDescriptor);

          if (!pages || !Array.isArray(pages)) return [];

          return pages.map((p, index) => {
            const page = p as Record<string, unknown>;
            return {
              index: (page.index as number) ?? index,
              url: (page.imageUrl as string | undefined) ?? (page.url as string | undefined),
              base64: page.base64 as string | undefined,
              text: page.text as string | undefined,
            };
          });
        } catch (e) {
          console.error("[Aidoku] OLD ABI getPageList error:", e);
          return [];
        } finally {
          scope.cleanup();
        }
      }

      // NEW ABI
      if (!wasmGetPageList) return [];

      const scope = store.createScope();
      try {
        const mangaBytes = encodeManga(manga);
        const mangaDescriptor = scope.storeValue(mangaBytes);

        const chapterBytes = encodeChapter(chapter);
        const chapterDescriptor = scope.storeValue(chapterBytes);

        const resultPtr = wasmGetPageList(mangaDescriptor, chapterDescriptor);
        const resultBytes = readResult(resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!resultBytes) return [];

        const decodedPages = decodePageList(resultBytes);

        return decodedPages.map((p, index) => ({
          index,
          url: p.url || undefined,
          base64: undefined,
          text: p.text || undefined,
          context: p.context || undefined,
        }));
      } catch (e) {
        console.error("[Aidoku] getPageList error:", e);
        return [];
      } finally {
        scope.cleanup();
      }
    },

    getFilters(): Filter[] {
      if (!getFilterList) return [];

      try {
        const resultPtr = getFilterList();
        const resultBytes = readResult(resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!resultBytes) return [];

        const decodedFilters = decodeFilterList(resultBytes);
        return decodedFilters.map(convertDecodedFilter);
      } catch (e) {
        console.error("[Aidoku] getFilterList error:", e);
        return [];
      }
    },

    modifyImageRequest(
      url: string,
      context?: Record<string, string> | null
    ): { url: string; headers: Record<string, string> } {
      const defaultHeaders: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      };
      const storedCookies = store.getCookiesForUrl(url);
      if (storedCookies) {
        defaultHeaders["Cookie"] = storedCookies;
      }

      // OLD ABI
      if (oldModifyImageRequest) {
        const requestId = store.createRequest();
        const request = store.requests.get(requestId);
        if (!request) {
          return { url, headers: defaultHeaders };
        }

        request.url = url;
        Object.assign(request.headers, defaultHeaders);

        try {
          oldModifyImageRequest(requestId);

          const modifiedRequest = store.requests.get(requestId);
          if (modifiedRequest) {
            const result = {
              url: modifiedRequest.url || url,
              headers: modifiedRequest.headers || {},
            };
            store.removeRequest(requestId);
            return result;
          }
        } catch (e) {
          console.error("[Aidoku] OLD ABI modifyImageRequest error:", e);
        }

        store.removeRequest(requestId);
        return { url, headers: defaultHeaders };
      }

      // NEW ABI
      if (!getImageRequest) {
        return { url, headers: defaultHeaders };
      }

      const scope = store.createScope();
      try {
        const urlBytes = encodeString(url);
        const urlDescriptor = scope.storeValue(urlBytes);

        let contextDescriptor = -1;
        if (context !== null && context !== undefined) {
          const contextBytes = encodeHashMap(context);
          contextDescriptor = scope.storeValue(contextBytes);
        }

        const resultPtr = getImageRequest(urlDescriptor, contextDescriptor);

        if (resultPtr < 0) {
          return { url, headers: defaultHeaders };
        }

        const payload = readResultPayload(memory, resultPtr);

        if (freeResult) {
          freeResult(resultPtr);
        }

        if (!payload) {
          return { url, headers: defaultHeaders };
        }

        const requestId = decodeRidFromPayload(payload);

        if (requestId === null) {
          return { url, headers: defaultHeaders };
        }

        const request = store.requests.get(requestId);

        if (request) {
          const result = {
            url: request.url || url,
            headers: request.headers || {},
          };
          store.removeRequest(requestId);
          return result;
        }

        return { url, headers: defaultHeaders };
      } catch (e) {
        console.error("[Aidoku] modifyImageRequest error:", e);
        return { url, headers: defaultHeaders };
      } finally {
        scope.cleanup();
      }
    },

    async processPageImage(
      imageData: Uint8Array,
      context: Record<string, string> | null,
      requestUrl: string,
      requestHeaders: Record<string, string>,
      responseCode: number,
      responseHeaders: Record<string, string>
    ): Promise<Uint8Array | null> {
      if (!processPageImageExport) {
        return null;
      }

      const scope = store.createScope();
      try {
        const imageResult = await createHostImage(store, imageData);
        if (!imageResult) {
          return null;
        }
        const { rid: imageRid } = imageResult;

        const responseBytes = encodeImageResponse(
          responseCode,
          responseHeaders,
          requestUrl,
          requestHeaders,
          imageRid
        );
        const responseDescriptor = scope.storeValue(responseBytes);

        let contextDescriptor = -1;
        if (context !== null) {
          const contextHashMapBytes = encodeHashMap(context);
          contextDescriptor = scope.storeValue(contextHashMapBytes);
        }

        const resultPtr = processPageImageExport(responseDescriptor, contextDescriptor);

        if (resultPtr < 0) {
          return null;
        }

        const payload = readResultPayload(memory, resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!payload || payload.length === 0) {
          return null;
        }

        const resultRid = decodeRidFromPayload(payload);

        if (resultRid === null) {
          return null;
        }

        return getHostImageData(store, resultRid);
      } catch {
        return null;
      } finally {
        scope.cleanup();
      }
    },

    getMangaListForListing(listing: Listing, page: number): MangaPageResult {
      if (!getMangaList || !isNewAbi) {
        return { entries: [], hasNextPage: false };
      }

      const scope = store.createScope();
      try {
        const listingBytes = encodeListing(listing);
        const listingDescriptor = scope.storeValue(listingBytes);

        const resultPtr = getMangaList(listingDescriptor, page);
        const resultBytes = readResult(resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!resultBytes) {
          return { entries: [], hasNextPage: false };
        }

        const decoded = decodeMangaPageResult(resultBytes);
        const entries: Manga[] = decoded.entries.map((m: DecodedManga) => ({
          sourceId: manifest.info.id,
          id: m.key,
          key: m.key,
          title: m.title || undefined,
          authors: m.authors || undefined,
          artists: m.artists || undefined,
          description: m.description || undefined,
          tags: m.tags || undefined,
          cover: m.cover || undefined,
          url: m.url || undefined,
          status: m.status as MangaStatus | undefined,
          nsfw: m.contentRating as ContentRating | undefined,
          viewer: m.viewer as Viewer | undefined,
        }));

        return { entries, hasNextPage: decoded.hasNextPage };
      } catch (e) {
        console.error("[Aidoku] getMangaListForListing error:", e);
        return { entries: [], hasNextPage: false };
      } finally {
        scope.cleanup();
      }
    },

    getHome(): HomeLayout | null {
      return getHomeImpl(() => {});
    },

    getHomeWithPartials(onPartial: (layout: HomeLayout) => void): HomeLayout | null {
      return getHomeImpl(onPartial);
    },

    getListings(): Listing[] {
      if (!getListings) return [];

      try {
        const resultPtr = getListings();
        const resultBytes = readResult(resultPtr);

        if (freeResult && resultPtr > 0) {
          freeResult(resultPtr);
        }

        if (!resultBytes) return [];

        const [listings] = decodeVec(resultBytes, 0, decodeListingForVec);
        return listings;
      } catch (e) {
        console.error("[Aidoku] getListings error:", e);
        return [];
      }
    },
  };
  };
}

// Helper to encode Listing for aidoku-rs
function encodeListing(listing: Listing): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeString(listing.id));
  parts.push(encodeString(listing.name));
  parts.push(new Uint8Array([listing.kind ?? 0]));
  return concatBytes(parts);
}

// Simple listing decoder for decodeVec
function decodeListingForVec(bytes: Uint8Array, offset: number): [Listing, number] {
  let pos = offset;
  let id: string;
  let name: string;

  [id, pos] = decodeString(bytes, pos);
  [name, pos] = decodeString(bytes, pos);
  const kind = bytes[pos] as 0 | 1;
  pos += 1;

  return [{ id, name, kind }, pos];
}

