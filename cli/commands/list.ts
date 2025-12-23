import { buildCommand } from "@stricli/core";
import { loadConfig } from "../config";
import { listSources, ContentRating } from "../lib/source-loader";
import { fetchAllRegistries } from "../lib/registry";
import { printHeader, printJson, printListItem } from "../lib/output";

const contentRatingLabels: Record<number, string> = {
  [ContentRating.Safe]: "",
  [ContentRating.Suggestive]: " [Suggestive]",
  [ContentRating.Nsfw]: " [NSFW]",
};

export const list = buildCommand({
  docs: {
    brief: "List available sources",
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        optional: true,
      },
      remote: {
        kind: "boolean",
        brief: "List sources from remote registries",
        optional: true,
      },
      lang: {
        kind: "parsed",
        brief: "Filter by language (e.g., 'en', 'ja')",
        parse: String,
        optional: true,
      },
    },
  },
  func: async (flags: { json?: boolean; remote?: boolean; lang?: string }) => {
    const config = loadConfig();

    if (flags.remote) {
      if (config.registries.length === 0) {
        console.error("No registries configured.");
        console.log("\nSet via environment variable:");
        console.log("  AIDOKU_REGISTRIES=https://example.com/sources/index.json");
        console.log("\nOr add to aidoku.config.json:");
        console.log('  { "registries": ["https://..."] }');
        process.exit(1);
      }

      const registries = await fetchAllRegistries(config.registries);
      const allSources = registries.flatMap((r) =>
        r.registry.sources.map((s) => ({ ...s, registry: r.registry.name }))
      );

      let sources = allSources;
      if (flags.lang) {
        sources = sources.filter((s) =>
          s.languages.some((l) =>
            l.toLowerCase().includes(flags.lang!.toLowerCase())
          )
        );
      }

      if (flags.json) {
        printJson(sources);
        return;
      }

      printHeader(`Remote Sources (${sources.length})`);
      for (const s of sources) {
        const rating = contentRatingLabels[s.contentRating] ?? "";
        const langs = s.languages.join(", ");
        printListItem(`${s.name} (${langs}) v${s.version}${rating}`);
        console.log(`    ID: ${s.id}`);
      }
      return;
    }

    // Local sources
    if (!config.sources) {
      console.log("No local sources configured.");
      console.log("\nUse --remote to list registry sources, or configure local sources:");
      console.log("  AIDOKU_SOURCES=./sources");
      return;
    }

    let sources = listSources(config.sources);
    if (flags.lang) {
      sources = sources.filter((s) =>
        s.lang.toLowerCase().includes(flags.lang!.toLowerCase())
      );
    }

    if (flags.json) {
      printJson(sources);
      return;
    }

    printHeader(`Sources (${sources.length})`);
    if (sources.length === 0) {
      console.log("No .aix sources found.");
      console.log(`Looked in: ${config.sources}`);
    } else {
      for (const s of sources) {
        const rating = contentRatingLabels[s.contentRating] ?? "";
        printListItem(`${s.name} (${s.lang}) v${s.version}${rating}`);
        console.log(`    ID: ${s.id}`);
      }
    }
  },
});
