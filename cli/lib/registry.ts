import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Normalized source info (combines old + new ABI fields)
 */
export interface RegistrySource {
  id: string;
  name: string;
  version: number;
  iconURL: string;
  downloadURL: string;
  languages: string[];
  contentRating: number;
  baseURL?: string;
}

export interface Registry {
  name: string;
  sources: RegistrySource[];
}

/**
 * Raw source info from registry JSON (may have old or new format)
 */
interface RawSourceInfo {
  id: string;
  name: string;
  version: number;
  // New format
  iconURL?: string;
  downloadURL?: string;
  languages?: string[];
  contentRating?: number;
  baseURL?: string;
  // Old format (deprecated)
  icon?: string;
  file?: string;
  lang?: string;
  nsfw?: number;
}

/**
 * Normalize a raw source entry to standard format
 * Handles both old ABI (icon, file, lang, nsfw) and new ABI (iconURL, downloadURL, languages, contentRating)
 */
function normalizeSource(raw: RawSourceInfo): RegistrySource {
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    // New format takes precedence, fall back to old format with path prefix
    iconURL: raw.iconURL ?? (raw.icon ? `icons/${raw.icon}` : ""),
    downloadURL: raw.downloadURL ?? (raw.file ? `sources/${raw.file}` : ""),
    // New format is array, old format is single string
    languages: raw.languages ?? (raw.lang ? [raw.lang] : []),
    // New format is contentRating, old format is nsfw
    contentRating: raw.contentRating ?? raw.nsfw ?? 0,
    baseURL: raw.baseURL,
  };
}

const CACHE_DIR = path.join(os.homedir(), ".cache", "aidoku");

export function getCacheDir(): string {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  return CACHE_DIR;
}

export function getCachedAixPath(sourceId: string, version: number): string {
  return path.join(getCacheDir(), `${sourceId}-v${version}.aix`);
}

export async function fetchRegistry(url: string): Promise<Registry> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch registry: ${response.status}`);
  }

  const data = await response.json();

  // Handle both formats:
  // 1. New format: { name: string, sources: SourceInfo[] }
  // 2. Old/array format: SourceInfo[] (just an array)
  if (Array.isArray(data)) {
    // Old array format - normalize each source
    return {
      name: new URL(url).hostname,
      sources: (data as RawSourceInfo[]).map(normalizeSource),
    };
  }

  // New format with name + sources
  const obj = data as { name?: string; sources?: RawSourceInfo[] };
  return {
    name: obj.name ?? new URL(url).hostname,
    sources: (obj.sources ?? []).map(normalizeSource),
  };
}

export async function fetchAllRegistries(
  urls: string[]
): Promise<{ url: string; registry: Registry }[]> {
  if (urls.length === 0) {
    return [];
  }

  const registries = await Promise.all(
    urls.map(async (url) => {
      try {
        const registry = await fetchRegistry(url);
        return { url, registry };
      } catch (e) {
        console.warn(`Warning: Failed to fetch registry ${url}: ${e}`);
        return null;
      }
    })
  );
  return registries.filter((r): r is NonNullable<typeof r> => r !== null);
}

export function findRegistrySource(
  registries: { url: string; registry: Registry }[],
  sourceId: string
): { source: RegistrySource; baseUrl: string } | null {
  for (const { url, registry } of registries) {
    const baseUrl = url.replace(/\/[^/]+$/, "/"); // Remove filename

    // Exact match
    const exact = registry.sources.find((s) => s.id === sourceId);
    if (exact) return { source: exact, baseUrl };

    // Partial match
    const partial = registry.sources.find(
      (s) =>
        s.id.includes(sourceId) ||
        s.name.toLowerCase().includes(sourceId.toLowerCase())
    );
    if (partial) return { source: partial, baseUrl };
  }
  return null;
}

export async function downloadAix(
  source: RegistrySource,
  baseUrl: string
): Promise<Uint8Array> {
  const downloadUrl = new URL(source.downloadURL, baseUrl).href;
  const cachePath = getCachedAixPath(source.id, source.version);

  // Check cache first
  if (fs.existsSync(cachePath)) {
    return new Uint8Array(fs.readFileSync(cachePath));
  }

  console.log(`Downloading ${source.name} v${source.version}...`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());

  // Cache it
  fs.writeFileSync(cachePath, buffer);
  console.log(`Cached to ${cachePath}`);

  return buffer;
}
