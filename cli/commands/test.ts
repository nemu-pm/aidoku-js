import { buildCommand, buildRouteMap } from "@stricli/core";
import pc from "picocolors";
import { requireSourceConfig } from "../config";
import {
  resolveAndLoadSource,
  type AsyncAidokuSource,
  type Manga,
  type SourceManifest,
} from "../lib/source-loader";
import { printHeader, printJson, printListItem } from "../lib/output";

function getLang(manifest: { info: { id: string; lang?: string; languages?: string[] } }): string {
  // Official Aidoku: use languages array, fall back to deprecated lang or id prefix
  return manifest.info.languages?.[0] 
    ?? manifest.info.lang 
    ?? manifest.info.id.split(".")[0];
}

async function getSource(sourceId: string): Promise<{ source: AsyncAidokuSource; name: string; manifest: SourceManifest }> {
  const config = requireSourceConfig();
  const { source, manifest } = await resolveAndLoadSource(config, sourceId);
  console.log(`Loaded: ${manifest.info.name} (${getLang(manifest)})\n`);
  return { source, name: manifest.info.name, manifest };
}

export const listings = buildCommand({
  docs: {
    brief: "Get source listings (popular, latest, etc.)",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Source ID or filename", parse: String, placeholder: "source" }],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean }, sourceId: string) => {
    const { source } = await getSource(sourceId);

    const result = await source.getListings();

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    printHeader(`Listings (${result.length})`);
    for (const l of result) {
      printListItem(`${l.name} (ID: ${l.id})`);
    }

    source.dispose();
  },
});

export const listing = buildCommand({
  docs: {
    brief: "Get manga for a specific listing",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Source ID or filename", parse: String, placeholder: "source" },
        { brief: "Listing ID", parse: String, placeholder: "listing" },
      ],
    },
    flags: {
      page: {
        kind: "parsed",
        brief: "Page number",
        parse: (s: string) => parseInt(s, 10),
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { page?: number; json?: boolean }, sourceId: string, listingId: string) => {
    const { source } = await getSource(sourceId);
    const page = flags.page ?? 1;

    const allListings = await source.getListings();
    const targetListing = allListings.find((l) => l.id === listingId);

    if (!targetListing) {
      console.error(`Listing not found: ${listingId}`);
      console.log(`Available: ${allListings.map((l) => l.id).join(", ")}`);
      source.dispose();
      process.exit(1);
    }

    console.log(`Fetching ${targetListing.name} (page ${page})...`);
    const result = await source.getMangaListForListing(targetListing, page);

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    printHeader(`${targetListing.name} (${result.entries.length} items, hasNextPage: ${result.hasNextPage})`);
    for (const m of result.entries.slice(0, 10)) {
      printListItem(m.title ?? m.key);
      console.log(`    Key: ${m.key}`);
      if (m.cover) console.log(`    Cover: ${m.cover}`);
    }
    if (result.entries.length > 10) {
      console.log(`\n... and ${result.entries.length - 10} more`);
    }

    source.dispose();
  },
});

export const search = buildCommand({
  docs: {
    brief: "Search for manga",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Source ID or filename", parse: String, placeholder: "source" },
        { brief: "Search query", parse: String, placeholder: "query" },
      ],
    },
    flags: {
      page: {
        kind: "parsed",
        brief: "Page number",
        parse: (s: string) => parseInt(s, 10),
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { page?: number; json?: boolean }, sourceId: string, query: string) => {
    const { source } = await getSource(sourceId);
    const page = flags.page ?? 1;

    console.log(`Searching for "${query}" (page ${page})...`);
    const result = await source.getSearchMangaList(query, page, []);

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    printHeader(`Search Results (${result.entries.length} items)`);
    for (const m of result.entries.slice(0, 10)) {
      printListItem(m.title ?? m.key);
      console.log(`    Key: ${m.key}`);
    }
    if (result.entries.length > 10) {
      console.log(`\n... and ${result.entries.length - 10} more`);
    }

    source.dispose();
  },
});

export const details = buildCommand({
  docs: {
    brief: "Get manga details",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Source ID or filename", parse: String, placeholder: "source" },
        { brief: "Manga key", parse: String, placeholder: "key" },
      ],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean }, sourceId: string, key: string) => {
    const { source } = await getSource(sourceId);

    console.log(`Fetching manga details...`);
    const result = await source.getMangaDetails({ key });

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    printHeader("Manga Details");
    console.log(JSON.stringify(result, null, 2));

    source.dispose();
  },
});

export const chapters = buildCommand({
  docs: {
    brief: "Get chapter list",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Source ID or filename", parse: String, placeholder: "source" },
        { brief: "Manga key", parse: String, placeholder: "key" },
      ],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean }, sourceId: string, key: string) => {
    const { source } = await getSource(sourceId);

    console.log(`Fetching chapter list...`);
    const result = await source.getChapterList({ key });

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    printHeader(`Chapters (${result.length})`);
    for (const c of result.slice(0, 10)) {
      printListItem(c.title ?? `Chapter ${c.chapterNumber ?? c.key}`);
      console.log(`    Key: ${c.key}`);
      if (c.scanlator) console.log(`    Scanlator: ${c.scanlator}`);
    }
    if (result.length > 10) {
      console.log(`\n... and ${result.length - 10} more`);
    }

    source.dispose();
  },
});

export const pages = buildCommand({
  docs: {
    brief: "Get page list for a chapter",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Source ID or filename", parse: String, placeholder: "source" },
        { brief: "Manga key", parse: String, placeholder: "mangaKey" },
        { brief: "Chapter key", parse: String, placeholder: "chapterKey" },
      ],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean }, sourceId: string, mangaKey: string, chapterKey: string) => {
    const { source } = await getSource(sourceId);

    console.log(`Fetching page list...`);
    const result = await source.getPageList({ key: mangaKey }, { key: chapterKey });

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    printHeader(`Pages (${result.length})`);
    for (const p of result.slice(0, 5)) {
      console.log(`Page ${p.index + 1}: ${p.url || "(base64)"}`);
    }
    if (result.length > 5) {
      console.log(`\n... and ${result.length - 5} more`);
    }

    source.dispose();
  },
});

export const filters = buildCommand({
  docs: {
    brief: "Get available filters",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Source ID or filename", parse: String, placeholder: "source" }],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean }, sourceId: string) => {
    const { source } = await getSource(sourceId);

    const result = await source.getFilters();

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    printHeader(`Filters (${result.length})`);
    for (const f of result) {
      printListItem(`${f.name} (type: ${f.type})`);
    }

    source.dispose();
  },
});

export const home = buildCommand({
  docs: {
    brief: "Get home layout (for sources with home provider)",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Source ID or filename", parse: String, placeholder: "source" }],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean }, sourceId: string) => {
    const { source } = await getSource(sourceId);

    const hasHome = await source.hasHomeProvider();
    if (!hasHome) {
      console.log(pc.yellow("Source does not provide home layout"));
      source.dispose();
      return;
    }

    console.log("Fetching home layout...");
    const result = await source.getHome();

    if (flags.json) {
      printJson(result);
      source.dispose();
      return;
    }

    if (!result) {
      console.log(pc.yellow("getHome returned null"));
      source.dispose();
      return;
    }

    printHeader(`Home Layout (${result.components.length} components)`);
    for (const c of result.components) {
      printListItem(`${c.title ?? "(untitled)"} [${c.value.type}]`);
      // Show entry count for certain types
      const value = c.value as { entries?: unknown[]; links?: unknown[] };
      if (value.entries) console.log(`    Entries: ${value.entries.length}`);
      if (value.links) console.log(`    Links: ${value.links.length}`);
    }

    source.dispose();
  },
});

export const capabilities = buildCommand({
  docs: {
    brief: "Show source capabilities (home, listings, filters)",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Source ID or filename", parse: String, placeholder: "source" }],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean }, sourceId: string) => {
    const config = requireSourceConfig();
    const { source, manifest } = await resolveAndLoadSource(config, sourceId);

    const hasHome = await source.hasHomeProvider();
    const hasListingProvider = await source.hasListingProvider();
    const hasListings = await source.hasListings();
    const isOnlySearch = await source.isOnlySearch();
    const listings = hasListings ? await source.getListings() : [];
    const filters = await source.getFilters();
    const handlesBasicLogin = await source.handlesBasicLogin();
    const handlesWebLogin = await source.handlesWebLogin();

    const caps = {
      id: manifest.info.id,
      name: manifest.info.name,
      languages: manifest.info.languages ?? [],
      hasHome,
      hasListings,
      listingCount: listings.length,
      filterCount: filters.length,
      handlesBasicLogin,
      handlesWebLogin,
      isOnlySearch,
      // Manifest-defined listings vs dynamic
      manifestListings: manifest.listings?.length ?? 0,
      manifestFilters: manifest.filters?.length ?? 0,
    };

    if (flags.json) {
      printJson(caps);
      source.dispose();
      return;
    }

    printHeader(`Source Capabilities: ${manifest.info.name}`);
    console.log(`  ID: ${manifest.info.id}`);
    console.log(`  Languages: ${manifest.info.languages?.join(", ") || "(none)"}`);
    console.log("");
    console.log(`  ${hasHome ? pc.green("✓") : pc.dim("-")} Home Provider (get_home)`);
    console.log(`  ${hasListingProvider ? pc.green("✓") : pc.dim("-")} Listing Provider (get_manga_list)`);
    console.log(`  ${hasListings ? pc.green("✓") : pc.dim("-")} Has Listings (${listings.length} total)`);
    console.log(`  ${filters.length > 0 ? pc.green("✓") : pc.dim("-")} Filters (${filters.length})`);
    console.log(`  ${handlesBasicLogin ? pc.green("✓") : pc.dim("-")} Basic Login Handler`);
    console.log(`  ${handlesWebLogin ? pc.green("✓") : pc.dim("-")} Web Login Handler`);
    console.log("");
    if (isOnlySearch) {
      console.log(pc.yellow("  ⚠ OnlySearch mode - no home AND no listings"));
    }

    source.dispose();
  },
});

// Image magic bytes for validation
const IMAGE_SIGNATURES: Array<{ name: string; bytes: number[] }> = [
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { name: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "WebP", bytes: [0x52, 0x49, 0x46, 0x46] },
];

function detectImageFormat(buffer: Uint8Array): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) {
      return sig.name;
    }
  }
  return null;
}

interface TestResult {
  test: string;
  passed: boolean;
  error?: string;
  data?: unknown;
}

export const all = buildCommand({
  docs: {
    brief: "Run all API tests on a source",
    fullDescription:
      "Comprehensive test that validates home/listings, search, details, chapters, pages, and images. Handles sources with home layout, listings, or search-only.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Source ID or filename", parse: String, placeholder: "source" }],
    },
    flags: {
      json: {
        kind: "boolean",
        brief: "Output results as JSON",
        optional: true,
      },
      query: {
        kind: "parsed",
        brief: "Search query for fallback testing",
        parse: String,
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean; query?: string }, sourceId: string) => {
    const config = requireSourceConfig();
    const { source, manifest } = await resolveAndLoadSource(config, sourceId);
    const results: TestResult[] = [];
    const log = flags.json ? () => {} : console.log;

    log(pc.cyan(`\n🧪 Testing: ${manifest.info.name} (${getLang(manifest)})\n`));

    // Check capabilities using official Aidoku logic
    const hasHome = await source.hasHomeProvider();
    const hasListingProvider = await source.hasListingProvider();
    const hasListings = await source.hasListings();
    const isOnlySearch = await source.isOnlySearch();
    log(pc.dim(`Capabilities: home=${hasHome}, listingProvider=${hasListingProvider}, hasListings=${hasListings}, onlySearch=${isOnlySearch}\n`));

    // Collect manga samples from any available source
    const mangaSamples: Manga[] = [];

    // Test 1A: Home Layout (if available)
    if (hasHome) {
      try {
        log(pc.dim("Testing home..."));
        const homeResult = await source.getHome();
        if (homeResult && homeResult.components.length > 0) {
          results.push({ test: "home", passed: true, data: { components: homeResult.components.length } });
          log(pc.green(`  ✓ home: ${homeResult.components.length} components`));

          // Extract manga samples from home components
          for (const c of homeResult.components) {
            const value = c.value as { entries?: Array<{ manga?: Manga }>; links?: Array<{ manga?: Manga }> };
            if (value.entries) {
              for (const e of value.entries.slice(0, 3)) {
                if (e.manga) mangaSamples.push(e.manga);
              }
            }
            if (value.links) {
              for (const l of value.links.slice(0, 3)) {
                if (l.manga) mangaSamples.push(l.manga);
              }
            }
            if (mangaSamples.length >= 5) break;
          }
          if (mangaSamples.length > 0) {
            log(pc.dim(`  (collected ${mangaSamples.length} manga samples from home)`));
          }
        } else {
          results.push({ test: "home", passed: true, data: { components: 0 } });
          log(pc.yellow(`  ⚠ home: empty layout`));
        }
      } catch (e) {
        results.push({ test: "home", passed: false, error: String(e) });
        log(pc.red(`  ✗ home: ${e}`));
      }
    }

    // Test 1B: Listings (if available)
    if (hasListings) {
      try {
        log(pc.dim("Testing listings..."));
        const listingsResult = await source.getListings();
        results.push({ test: "listings", passed: true, data: { count: listingsResult.length } });
        log(pc.green(`  ✓ listings: ${listingsResult.length} listings`));

        // Get manga from first listing (if we don't have samples yet)
        if (listingsResult.length > 0 && mangaSamples.length < 5) {
          const firstListing = listingsResult[0];
          log(pc.dim(`Testing listing "${firstListing.name}"...`));
          const listingResult = await source.getMangaListForListing(firstListing, 1);
          mangaSamples.push(...listingResult.entries.slice(0, 5));
          results.push({
            test: "listing",
            passed: true,
            data: { listing: firstListing.name, count: listingResult.entries.length },
          });
          log(pc.green(`  ✓ listing: ${listingResult.entries.length} manga`));
        }
      } catch (e) {
        results.push({ test: "listings", passed: false, error: String(e) });
        log(pc.red(`  ✗ listings: ${e}`));
      }
    }

    // Test 1C: Browse (empty query) - this is how onlySearch sources show their "home"
    // In Aidoku, calling getSearchMangaList with empty/nil query returns default manga list
    if (mangaSamples.length === 0) {
      try {
        log(pc.dim("Testing browse (empty query)..."));
        const browseResult = await source.getSearchMangaList("", 1, []);
        const count = browseResult.entries.length;
        if (count > 0) {
          results.push({ test: "browse", passed: true, data: { count } });
          log(pc.green(`  ✓ browse: ${count} manga`));
          mangaSamples.push(...browseResult.entries.slice(0, 5));
        } else {
          results.push({ test: "browse", passed: true, data: { count: 0 } });
          log(pc.yellow(`  ⚠ browse: empty results`));
        }
      } catch (e) {
        results.push({ test: "browse", passed: false, error: String(e) });
        log(pc.red(`  ✗ browse: ${e}`));
      }
    }

    // Test 1D: Search with query
    const searchQuery = flags.query 
      ?? (mangaSamples.length > 0 ? (mangaSamples[0].title ?? "").slice(0, 20) : null)
      ?? "manga";
    try {
      log(pc.dim(`Testing search ("${searchQuery}")...`));
      const searchResult = await source.getSearchMangaList(searchQuery, 1, []);
      const count = searchResult.entries.length;
      results.push({ test: "search", passed: true, data: { query: searchQuery, count } });
      log(pc.green(`  ✓ search: ${count} results`));
      
      // Add search results to samples if needed
      if (mangaSamples.length < 5) {
        mangaSamples.push(...searchResult.entries.slice(0, 5 - mangaSamples.length));
      }
    } catch (e) {
      results.push({ test: "search", passed: false, error: String(e) });
      log(pc.red(`  ✗ search: ${e}`));
    }

    // Test 2: Filters
    try {
      log(pc.dim("Testing filters..."));
      const filtersResult = await source.getFilters();
      results.push({ test: "filters", passed: true, data: { count: filtersResult.length } });
      log(pc.green(`  ✓ filters: ${filtersResult.length} filters`));
    } catch (e) {
      results.push({ test: "filters", passed: false, error: String(e) });
      log(pc.red(`  ✗ filters: ${e}`));
    }

    // Test 3: Manga Details
    let detailsManga: Manga | null = null;
    for (const manga of mangaSamples.slice(0, 3)) {
      try {
        log(pc.dim(`Testing details (${(manga.title ?? manga.key).slice(0, 30)})...`));
        const detailsResult = await source.getMangaDetails(manga);
        detailsManga = detailsResult;
        results.push({ test: "details", passed: true, data: { title: detailsResult.title || manga.key } });
        log(pc.green(`  ✓ details: ${detailsResult.title || manga.key}`));
        break;
      } catch {
        log(pc.dim(`    (${(manga.title ?? manga.key).slice(0, 20)} failed, trying next...)`));
      }
    }
    if (!detailsManga) {
      results.push({ test: "details", passed: false, error: "All manga samples failed" });
      log(pc.red(`  ✗ details: All ${Math.min(3, mangaSamples.length)} samples failed`));
    }

    // Test 4: Chapters
    let chaptersData: { manga: Manga; chapters: Array<{ key: string; title?: string }> } | null = null;
    for (const manga of mangaSamples.slice(0, 3)) {
      try {
        log(pc.dim(`Testing chapters (${(manga.title ?? manga.key).slice(0, 30)})...`));
        const chapterList = await source.getChapterList(manga);
        if (chapterList.length > 0) {
          chaptersData = { manga, chapters: chapterList };
          results.push({ test: "chapters", passed: true, data: { manga: manga.title, count: chapterList.length } });
          log(pc.green(`  ✓ chapters: ${chapterList.length} chapters`));
          break;
        }
        log(pc.dim(`    (${(manga.title ?? manga.key).slice(0, 20)} has no chapters, trying next...)`));
      } catch {
        log(pc.dim(`    (${(manga.title ?? manga.key).slice(0, 20)} failed, trying next...)`));
      }
    }
    if (!chaptersData) {
      results.push({ test: "chapters", passed: false, error: "No manga with chapters found" });
      log(pc.red(`  ✗ chapters: No manga with chapters found`));
    }

    // Test 5: Pages
    let samplePages: Array<{ index: number; url?: string }> = [];
    if (chaptersData) {
      for (const chapter of chaptersData.chapters.slice(0, 3)) {
        try {
          log(pc.dim(`Testing pages (${(chapter.title ?? chapter.key).slice(0, 30)})...`));
          const pageList = await source.getPageList(chaptersData.manga, chapter);
          if (pageList.length > 0) {
            samplePages = pageList.slice(0, 3);
            results.push({
              test: "pages",
              passed: true,
              data: { chapter: chapter.title || chapter.key, count: pageList.length },
            });
            log(pc.green(`  ✓ pages: ${pageList.length} pages`));
            break;
          }
          log(pc.dim(`    (${(chapter.title ?? chapter.key).slice(0, 20)} has no pages, trying next...)`));
        } catch {
          log(pc.dim(`    (${(chapter.title ?? chapter.key).slice(0, 20)} failed, trying next...)`));
        }
      }
      if (samplePages.length === 0) {
        results.push({ test: "pages", passed: false, error: "No chapter with pages found" });
        log(pc.red(`  ✗ pages: No chapter with pages found`));
      }
    }

    // Test 6: Image Download (test modifyImageRequest)
    if (samplePages.length > 0 && samplePages[0].url) {
      log(pc.dim("Testing image request modification..."));
      try {
        const pageUrl = samplePages[0].url!;
        const modified = await source.modifyImageRequest(pageUrl);

        // Actually fetch the image to validate
        const response = await fetch(modified.url, { headers: modified.headers });
        if (response.ok) {
          const buffer = new Uint8Array(await response.arrayBuffer());
          const format = detectImageFormat(buffer);
          results.push({
            test: "image",
            passed: true,
            data: { format, size: buffer.length, headers: Object.keys(modified.headers) },
          });
          log(pc.green(`  ✓ image: ${format || "binary"} (${(buffer.length / 1024).toFixed(1)}KB)`));
        } else {
          results.push({ test: "image", passed: false, error: `HTTP ${response.status}` });
          log(pc.red(`  ✗ image: HTTP ${response.status}`));
        }
      } catch (e) {
        results.push({ test: "image", passed: false, error: String(e) });
        log(pc.red(`  ✗ image: ${e}`));
      }
    }

    // Summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    if (flags.json) {
      printJson({
        source: sourceId,
        manifest: { id: manifest.info.id, name: manifest.info.name, languages: manifest.info.languages },
        summary: { passed, failed, total: results.length },
        results,
      });
    } else {
      log("");
      if (failed === 0) {
        log(pc.green(`✓ All ${passed} tests passed`));
      } else {
        log(pc.yellow(`⚠ ${passed}/${passed + failed} tests passed`));
      }
    }

    source.dispose();

    if (failed > 0) {
      process.exit(1);
    }
  },
});

// Route map for test subcommands
export const testRoutes = buildRouteMap({
  routes: {
    all,
    capabilities,
    home,
    listings,
    listing,
    search,
    details,
    chapters,
    pages,
    filters,
  },
  docs: {
    brief: "Test source API endpoints",
  },
});
