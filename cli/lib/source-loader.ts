import * as fs from "fs";
import * as path from "path";
import {
  loadSource,
  extractAix,
  isAixPackage,
  type AsyncAidokuSource,
  type SourceManifest,
  type Manga,
  type Chapter,
  type Page,
  type MangaPageResult,
  type Listing,
  type Filter,
  ContentRating,
} from "@nemu.pm/aidoku-runtime";
import {
  fetchAllRegistries,
  findRegistrySource,
  downloadAix,
  type RegistrySource,
} from "./registry";
import type { Config } from "../config";

export interface SourceListItem {
  id: string;
  name: string;
  /** Primary language (first from languages array) */
  lang: string;
  /** All supported languages */
  languages: string[];
  version: number;
  contentRating: number;
  path: string;
}

export interface LoadedSource {
  source: AsyncAidokuSource;
  manifest: SourceManifest;
  path: string;
}

/** List available .aix sources in directory */
export function listSources(sourcesDir: string): SourceListItem[] {
  if (!fs.existsSync(sourcesDir)) {
    return [];
  }

  const sources: SourceListItem[] = [];
  const files = fs.readdirSync(sourcesDir);

  for (const file of files) {
    if (!file.endsWith(".aix")) continue;

    const filePath = path.join(sourcesDir, file);
    try {
      const data = fs.readFileSync(filePath);
      if (!isAixPackage(data)) continue;

      const { manifest } = extractAix(data);
      sources.push({
        id: manifest.info.id,
        name: manifest.info.name,
        lang: manifest.info.languages?.[0] ?? manifest.info.id.split(".")[0],
        languages: manifest.info.languages ?? [],
        version: manifest.info.version,
        contentRating: manifest.info.contentRating ?? ContentRating.Safe,
        path: filePath,
      });
    } catch {
      // Skip invalid files
    }
  }

  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

/** Find source by ID or filename */
export function findSource(
  sourcesDir: string,
  sourceId: string
): SourceListItem | null {
  const sources = listSources(sourcesDir);

  // Try exact ID match first
  const byId = sources.find((s) => s.id === sourceId);
  if (byId) return byId;

  // Try filename match (without .aix)
  const byName = sources.find(
    (s) =>
      path.basename(s.path, ".aix").toLowerCase() === sourceId.toLowerCase()
  );
  if (byName) return byName;

  // Try partial match
  const partial = sources.find(
    (s) =>
      s.id.toLowerCase().includes(sourceId.toLowerCase()) ||
      s.name.toLowerCase().includes(sourceId.toLowerCase())
  );
  return partial ?? null;
}

/** Load a source by ID or filename from local directory */
export async function loadSourceById(
  sourcesDir: string,
  sourceId: string
): Promise<LoadedSource> {
  const info = findSource(sourcesDir, sourceId);
  if (!info) {
    throw new Error(`Source not found: ${sourceId}\nLooked in: ${sourcesDir}`);
  }

  const data = fs.readFileSync(info.path);
  const source = await loadSource(data, info.id, {});

  return {
    source,
    manifest: source.manifest,
    path: info.path,
  };
}

/** Load source from anywhere: local dir, cache, or remote registry */
export async function resolveAndLoadSource(
  config: Config,
  sourceId: string
): Promise<LoadedSource> {
  // 1. Try local directory first
  if (config.sources) {
    const local = findSource(config.sources, sourceId);
    if (local) {
      const data = fs.readFileSync(local.path);
      const source = await loadSource(data, local.id, {});
      return { source, manifest: source.manifest, path: local.path };
    }
  }

  // 2. Try remote registries
  if (config.registries.length === 0) {
    const locations = config.sources ? `Local: ${config.sources}` : "No sources configured";
    throw new Error(`Source not found: ${sourceId}\nSearched:\n  ${locations}`);
  }

  const registries = await fetchAllRegistries(config.registries);
  const found = findRegistrySource(registries, sourceId);

  if (!found) {
    const locations = [
      config.sources && `Local: ${config.sources}`,
      `Registries: ${config.registries.join(", ")}`,
    ].filter(Boolean);
    throw new Error(
      `Source not found: ${sourceId}\nSearched:\n  ${locations.join("\n  ")}`
    );
  }

  // 3. Download (or use cache)
  const data = await downloadAix(found.source, found.baseUrl);
  const source = await loadSource(data, found.source.id, {});

  return {
    source,
    manifest: source.manifest,
    path: `registry:${found.source.id}`,
  };
}

// Re-export types for convenience
export type {
  AsyncAidokuSource,
  SourceManifest,
  Manga,
  Chapter,
  Page,
  MangaPageResult,
  Listing,
  Filter,
  RegistrySource,
};
export { ContentRating };
