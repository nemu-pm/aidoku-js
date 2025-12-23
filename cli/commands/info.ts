import { buildCommand } from "@stricli/core";
import { requireSourceConfig } from "../config";
import { resolveAndLoadSource, ContentRating } from "../lib/source-loader";
import { printField, printHeader, printJson, printListItem } from "../lib/output";

const contentRatingLabels: Record<number, string> = {
  [ContentRating.Safe]: "Safe",
  [ContentRating.Suggestive]: "Suggestive",
  [ContentRating.Nsfw]: "NSFW",
};

export const info = buildCommand({
  docs: {
    brief: "Show source information",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Source ID or filename",
          parse: String,
          placeholder: "source",
        },
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
  func: async (flags: { json?: boolean }, sourceId: string) => {
    const config = requireSourceConfig();
    const { source, manifest, path } = await resolveAndLoadSource(config, sourceId);

    if (flags.json) {
      printJson({
        manifest,
        path,
        settingsJson: source.settingsJson,
      });
      source.dispose();
      return;
    }

    printHeader("Source Info");
    printField("Name", manifest.info.name);
    printField("ID", manifest.info.id);
    printField("Language", manifest.info.lang);
    printField("Version", manifest.info.version);
    printField("Content Rating", contentRatingLabels[manifest.info.contentRating ?? 0]);
    if (manifest.info.url) {
      printField("URL", manifest.info.url);
    }
    printField("File", path);

    // Show settings if available (from manifest, no WASM call needed)
    if (source.settingsJson && source.settingsJson.length > 0) {
      printHeader(`Settings (${source.settingsJson.length})`);
      for (const s of source.settingsJson as Array<{ key: string; title?: string; type?: string }>) {
        printListItem(`${s.title || s.key} (${s.type || "unknown"})`);
      }
    }

    source.dispose();
  },
});
