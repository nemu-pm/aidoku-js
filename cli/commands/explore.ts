import { buildCommand } from "@stricli/core";
import { select, input } from "@inquirer/prompts";
import pc from "picocolors";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";
import {
  listSources,
  resolveAndLoadSource,
  ContentRating,
  type AsyncAidokuSource,
  type Manga,
  type Chapter,
  type Page,
  type Listing,
  type RegistrySource,
} from "../lib/source-loader";
import { fetchAllRegistries } from "../lib/registry";

const contentRatingLabels: Record<number, string> = {
  [ContentRating.Safe]: "",
  [ContentRating.Suggestive]: " [Suggestive]",
  [ContentRating.Nsfw]: " [NSFW]",
};

interface SourceChoice {
  id: string;
  name: string;
  lang: string;
  version: number;
  contentRating: number;
  isRemote: boolean;
}

export const explore = buildCommand({
  docs: {
    brief: "Interactive mode to explore manga",
    fullDescription:
      "Browse manga interactively - select sources, browse listings, search, view details and chapters.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {},
  },
  func: async () => {
    const config = loadConfig();

    console.log(pc.cyan("\n🔍 Aidoku Source Explorer\n"));

    // Collect all available sources
    const allSources: SourceChoice[] = [];

    // Add local sources
    if (config.sources) {
      const localSources = listSources(config.sources);
      for (const s of localSources) {
        allSources.push({
          id: s.id,
          name: s.name,
          lang: s.lang,
          version: s.version,
          contentRating: s.contentRating,
          isRemote: false,
        });
      }
    }

    // Add remote sources
    if (config.registries.length > 0) {
      console.log(pc.dim("Fetching remote sources..."));
      const registries = await fetchAllRegistries(config.registries);
      for (const { registry } of registries) {
        for (const s of registry.sources) {
          // Skip if we already have this source locally
          if (allSources.some((x) => x.id === s.id)) continue;
          allSources.push({
            id: s.id,
            name: s.name,
            lang: s.languages[0] || "multi",
            version: s.version,
            contentRating: s.contentRating,
            isRemote: true,
          });
        }
      }
    }

    if (allSources.length === 0) {
      console.log(pc.red("No sources available."));
      console.log("\nConfigure local sources or registries:");
      console.log("  AIDOKU_SOURCES=./sources");
      console.log("  AIDOKU_REGISTRIES=https://example.com/sources/index.json");
      return;
    }

    // Sort by name
    allSources.sort((a, b) => a.name.localeCompare(b.name));

    // Select source
    const sourceId = await select({
      message: "Select a source",
      choices: allSources.map((s) => ({
        name: `${s.isRemote ? "🌐 " : "📁 "}${s.name} (${s.lang}) v${s.version}${contentRatingLabels[s.contentRating] ?? ""}`,
        value: s.id,
      })),
      pageSize: 20,
    });

    const { source, manifest } = await resolveAndLoadSource(config, sourceId);
    console.log(pc.green(`\nLoaded: ${manifest.info.name}`));

    // Get listings for this source
    const listings = await source.getListings();

    // Main loop
    while (true) {
      const choices: Array<{ name: string; value: string }> = [];

      // Add listing options
      for (const l of listings) {
        choices.push({ name: `📚 ${l.name}`, value: `listing:${l.id}` });
      }

      choices.push({ name: "🔎 Search", value: "search" });
      choices.push({ name: "🚪 Exit", value: "exit" });

      const action = await select({
        message: "What would you like to do?",
        choices,
      });

      if (action === "exit") break;

      let mangas: Manga[] = [];
      let page = 1;
      let hasNextPage = true;
      let currentListing: Listing | null = null;

      if (action === "search") {
        const query = await input({ message: "Search query:" });
        if (!query.trim()) continue;

        console.log(pc.dim(`\nSearching for "${query}"...`));
        const result = await source.getSearchMangaList(query, page, []);
        mangas = result.entries;
        hasNextPage = result.hasNextPage;
      } else if (action.startsWith("listing:")) {
        const listingId = action.slice(8);
        currentListing = listings.find((l) => l.id === listingId) ?? null;

        if (currentListing) {
          console.log(pc.dim(`\nFetching ${currentListing.name}...`));
          const result = await source.getMangaListForListing(currentListing, page);
          mangas = result.entries;
          hasNextPage = result.hasNextPage;
        }
      }

      if (mangas.length === 0) {
        console.log(pc.yellow("\nNo manga found."));
        continue;
      }

      // Manga selection loop
      while (true) {
        const mangaChoices = [
          ...mangas.map((m, i) => ({
            name: `${i + 1}. ${m.title ?? m.key}`,
            value: String(i),
          })),
          ...(hasNextPage ? [{ name: "📄 Load more", value: "more" }] : []),
          { name: "⬅ Back", value: "back" },
        ];

        const mangaChoice = await select({
          message: `Found ${mangas.length} manga:`,
          choices: mangaChoices,
          pageSize: 15,
        });

        if (mangaChoice === "back") break;
        if (mangaChoice === "more" && currentListing) {
          page++;
          console.log(pc.dim(`\nLoading page ${page}...`));
          const result = await source.getMangaListForListing(currentListing, page);
          mangas = [...mangas, ...result.entries];
          hasNextPage = result.hasNextPage;
          continue;
        }

        const manga = mangas[parseInt(mangaChoice)];
        await showMangaDetails(source, manga);
      }
    }

    source.dispose();
    console.log(pc.dim("\nBye! 👋"));
  },
});

async function showMangaDetails(source: AsyncAidokuSource, manga: Manga) {
  console.log(pc.dim("\nFetching details..."));

  const details = await source.getMangaDetails(manga);

  console.log("\n" + pc.bold(pc.cyan(details.title ?? manga.key)));
  if (details.authors?.length) console.log(pc.dim(`Authors: ${details.authors.join(", ")}`));
  if (details.artists?.length && details.artists.join(",") !== details.authors?.join(",")) {
    console.log(pc.dim(`Artists: ${details.artists.join(", ")}`));
  }
  if (details.status !== undefined) {
    const statusMap: Record<number, string> = {
      0: "Unknown",
      1: "Ongoing",
      2: "Completed",
      3: "Cancelled",
      4: "Hiatus",
    };
    console.log(pc.dim(`Status: ${statusMap[details.status] || "Unknown"}`));
  }
  if (details.tags?.length) {
    console.log(pc.dim(`Tags: ${details.tags.join(", ")}`));
  }
  if (details.description) {
    const desc = details.description.replace(/<[^>]*>/g, "").slice(0, 300);
    console.log(pc.dim(`\n${desc}${details.description.length > 300 ? "..." : ""}`));
  }

  while (true) {
    const detailAction = await select({
      message: "What next?",
      choices: [
        { name: "📚 View Chapters", value: "chapters" },
        { name: "🔗 Show Key/URL", value: "url" },
        { name: "📋 Raw JSON", value: "json" },
        { name: "⬅ Back", value: "back" },
      ],
    });

    if (detailAction === "back") break;

    if (detailAction === "url") {
      console.log(pc.cyan(`\nKey: ${manga.key}`));
      if (manga.url) console.log(pc.cyan(`URL: ${manga.url}`));
      if (details.cover) console.log(pc.cyan(`Cover: ${details.cover}`));
    } else if (detailAction === "json") {
      console.log("\n" + JSON.stringify(details, null, 2));
    } else if (detailAction === "chapters") {
      await showChapters(source, details);
    }
  }
}

async function showChapters(source: AsyncAidokuSource, manga: Manga) {
  console.log(pc.dim("\nFetching chapters..."));

  const chapters = await source.getChapterList(manga);

  if (chapters.length === 0) {
    console.log(pc.yellow("No chapters found."));
    return;
  }

  console.log(pc.green(`\nFound ${chapters.length} chapters`));

  while (true) {
    const chapterChoices = [
      ...chapters.slice(0, 20).map((c, i) => ({
        name: `${i + 1}. ${c.title ?? `Chapter ${c.chapterNumber ?? c.key}`}`,
        value: String(i),
      })),
      ...(chapters.length > 20 ? [{ name: `... and ${chapters.length - 20} more`, value: "info" }] : []),
      { name: "⬅ Back", value: "back" },
    ];

    const chapterChoice = await select({
      message: "Select a chapter to view pages:",
      choices: chapterChoices,
      pageSize: 15,
    });

    if (chapterChoice === "back") break;
    if (chapterChoice === "info") {
      console.log(pc.dim(`\nTotal: ${chapters.length} chapters`));
      console.log(pc.dim(`First: ${chapters[0].title ?? chapters[0].key}`));
      console.log(pc.dim(`Last: ${chapters[chapters.length - 1].title ?? chapters[chapters.length - 1].key}`));
      continue;
    }

    const chapter = chapters[parseInt(chapterChoice)];
    await showPages(source, manga, chapter);
  }
}

async function showPages(source: AsyncAidokuSource, manga: Manga, chapter: Chapter) {
  console.log(pc.dim("\nFetching pages..."));

  const pages = await source.getPageList(manga, chapter);

  if (pages.length === 0) {
    console.log(pc.yellow("No pages found."));
    return;
  }

  console.log(pc.green(`\n${chapter.title ?? chapter.key} - ${pages.length} pages`));

  while (true) {
    const pageAction = await select({
      message: `${pages.length} pages:`,
      choices: [
        { name: "📥 Download all pages", value: "download-all" },
        { name: "🖼️  Browse pages...", value: "browse" },
        { name: "📋 Show all URLs (JSON)", value: "json" },
        { name: "⬅ Back", value: "back" },
      ],
    });

    if (pageAction === "back") break;

    if (pageAction === "json") {
      console.log("\n" + JSON.stringify(pages, null, 2));
    } else if (pageAction === "download-all") {
      await downloadChapter(source, manga, chapter, pages);
    } else if (pageAction === "browse") {
      await browsePagesMenu(source, manga, chapter, pages);
    }
  }
}

async function browsePagesMenu(
  source: AsyncAidokuSource,
  manga: Manga,
  chapter: Chapter,
  pages: Page[]
) {
  let lastSelectedIdx = 0;

  while (true) {
    const pageChoices = [
      ...pages.map((p) => ({
        name: `Page ${String(p.index + 1).padStart(3, "0")}: ${(p.url || "base64").slice(0, 60)}${(p.url || "").length > 60 ? "..." : ""}`,
        value: String(p.index),
      })),
      { name: "⬅ Back", value: "back" },
    ];

    const pageChoice = await select({
      message: "Select a page:",
      choices: pageChoices,
      pageSize: 20,
      default: String(lastSelectedIdx),
    });

    if (pageChoice === "back") break;

    lastSelectedIdx = parseInt(pageChoice);
    const page = pages[lastSelectedIdx];
    await showSinglePage(source, manga, chapter, page);
  }
}

async function showSinglePage(
  source: AsyncAidokuSource,
  manga: Manga,
  chapter: Chapter,
  page: Page
) {
  const pageNum = String(page.index + 1).padStart(3, "0");
  const imageUrl = page.url || "(base64 data)";

  console.log(pc.cyan(`\nPage ${pageNum}`));
  console.log(pc.dim(`URL: ${imageUrl}`));

  const action = await select({
    message: "Options:",
    choices: [
      { name: "📥 Download this page", value: "download" },
      { name: "📋 Show URL", value: "copy" },
      { name: "⬅ Back", value: "back" },
    ],
  });

  if (action === "back") return;

  if (action === "copy") {
    if (page.url) {
      const modified = await source.modifyImageRequest(page.url);
      console.log(pc.green(`\nURL: ${modified.url}`));
      if (Object.keys(modified.headers).length > 0) {
        console.log(pc.dim(`Headers: ${JSON.stringify(modified.headers)}`));
      }
    } else {
      console.log(pc.yellow("\nNo URL available (base64 embedded)"));
    }
  } else if (action === "download") {
    await downloadSinglePage(source, manga, chapter, page);
  }
}

async function downloadSinglePage(
  source: AsyncAidokuSource,
  manga: Manga,
  chapter: Chapter,
  page: Page
) {
  const pageNum = String(page.index + 1).padStart(3, "0");

  const mangaFolder = sanitizeFilename(manga.title ?? manga.key);
  const chapterFolder = sanitizeFilename(chapter.title ?? `Chapter_${chapter.chapterNumber ?? chapter.key}`);
  const ext = page.url?.match(/\.(jpe?g|png|gif|webp)/i)?.[1]?.toLowerCase() || "jpg";
  const defaultPath = path.join("downloads", mangaFolder, chapterFolder, `${pageNum}.${ext}`);

  const outputPath = await input({
    message: "Save as:",
    default: defaultPath,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  console.log(pc.dim("\nDownloading..."));

  try {
    let buffer: Uint8Array;

    if (page.base64) {
      buffer = Buffer.from(page.base64, "base64");
    } else if (page.url) {
      const modified = await source.modifyImageRequest(page.url);
      const response = await fetch(modified.url, { headers: modified.headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new Error("No image data available");
    }

    fs.writeFileSync(outputPath, buffer);
    console.log(pc.green(`✓ Saved ${outputPath} (${(buffer.length / 1024).toFixed(1)}KB)`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`✗ Failed: ${msg}`));
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

async function downloadChapter(
  source: AsyncAidokuSource,
  manga: Manga,
  chapter: Chapter,
  pages: Page[]
) {
  const mangaFolder = sanitizeFilename(manga.title ?? manga.key);
  const chapterFolder = sanitizeFilename(chapter.title ?? `Chapter_${chapter.chapterNumber ?? chapter.key}`);
  const defaultDir = path.join("downloads", mangaFolder, chapterFolder);

  const outputDir = await input({
    message: "Download directory:",
    default: defaultDir,
  });

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(pc.cyan(`\nDownloading ${pages.length} pages to ${outputDir}...\n`));

  let downloaded = 0;
  let failed = 0;

  for (const page of pages) {
    const pageNum = String(page.index + 1).padStart(3, "0");

    try {
      process.stdout.write(pc.dim(`Page ${pageNum}...`));

      let buffer: Uint8Array;

      if (page.base64) {
        buffer = Buffer.from(page.base64, "base64");
      } else if (page.url) {
        const modified = await source.modifyImageRequest(page.url);
        const response = await fetch(modified.url, { headers: modified.headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        buffer = new Uint8Array(await response.arrayBuffer());
      } else {
        throw new Error("No image data");
      }

      const ext = page.url?.match(/\.(jpe?g|png|gif|webp)/i)?.[1]?.toLowerCase() || "jpg";
      const filename = `${pageNum}.${ext}`;
      const filepath = path.join(outputDir, filename);

      fs.writeFileSync(filepath, buffer);
      process.stdout.write(pc.green(` ✓ ${filename} (${(buffer.length / 1024).toFixed(1)}KB)\n`));
      downloaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(pc.red(` ✗ ${msg.slice(0, 50)}\n`));
      failed++;
    }
  }

  console.log(pc.green(`\n✓ Downloaded ${downloaded}/${pages.length} pages`));
  if (failed > 0) {
    console.log(pc.yellow(`⚠ ${failed} pages failed`));
  }
  console.log(pc.dim(`Saved to: ${path.resolve(outputDir)}`));
}
