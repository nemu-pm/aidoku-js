/**
 * @aidoku-js/runtime - Aidoku WASM Runtime for JavaScript
 *
 * This library provides a runtime for loading and executing Aidoku source modules
 * (WASM) in JavaScript environments.
 *
 * Node.js/Bun entry point - uses sync HTTP + `canvas` npm package.
 * 
 * @example
 * ```typescript
 * import { loadSource } from "@aidoku-js/runtime";
 * 
 * const source = await loadSource(aixBytes, "my-source", {});
 * const results = await source.getSearchMangaList("one piece", 1, []);
 * ```
 */

// Primary async API (recommended)
export { loadSource, type AsyncAidokuSource, type AsyncLoadOptions } from "./async/index.node";

// Sync API (for advanced usage)
export { createLoadSource, type AidokuSource, type AidokuRuntimeOptions, type CanvasModule, type SourceComponents, type SourceInput } from "./runtime";

// HTTP bridge utilities
export { createSyncNodeBridge, type SyncNodeHttpOptions } from "./http/sync-node";

// Canvas initialization for Node.js
export { initCanvasModule } from "./imports/canvas.node";

// AIX extraction utilities
export { extractAix, isAixPackage, type AixContents } from "./aix";

// Types
export type {
  // Core types
  Manga,
  Chapter,
  Page,
  MangaPageResult,
  SourceManifest,
  SourceInfo,
  SettingDef,
  DeepLink,
  ImageResponse,
  DiscoveredSource,
  FilterInfo,

  // Filter types
  Filter,
  FilterValue,
  BaseFilter,
  TitleFilter,
  AuthorFilter,
  TextFilter,
  SelectFilter,
  SortFilter,
  SortSelection,
  CheckFilter,
  GroupFilter,
  GenreFilter,
  GenreSelection,
  MultiSelectValue,

  // Listing types
  Listing,
  ListingKind,
  HomeLayout,
  HomeComponent,
  HomeComponentValue,
  HomeImageScroller,
  HomeBigScroller,
  HomeScroller,
  HomeMangaList,
  HomeMangaChapterList,
  HomeFilters,
  HomeLinks,
  HomeLink,
  HomeLinkValue,
  HomeFilterItem,
  MangaWithChapter,

  // HTTP types
  HttpBridge,
  HttpRequest,
  HttpResponse,
} from "./types";

// Enums
export {
  MangaStatus,
  ContentRating,
  Viewer,
  FilterType,
  GenreState,
  ObjectType,
} from "./types";

// Import types re-exports
export type { SettingsGetter, SettingsSetter } from "./imports/defaults";

// Result decoder utilities
export { RuntimeMode, detectRuntimeMode } from "./result-decoder";

// GlobalStore (for advanced usage)
export { GlobalStore } from "./global-store";

// Errors
export { CloudflareBlockedError } from "./imports/net";

// Cloudflare bypass via agent
export { solveViaAgent } from "./cloudflare/agent";
export type { CfCookie, CloudflareBypass } from "./cloudflare/types";
