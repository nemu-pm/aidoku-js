import * as fs from "fs";
import * as path from "path";

export interface Config {
  /** Path to .aix source files (optional if using registries) */
  sources?: string;
  /** Remote registries to fetch sources from */
  registries: string[];
}

const CONFIG_FILE_NAMES = ["aidoku.config.json", ".aidokurc.json"];

function findConfigFile(): string | null {
  for (const name of CONFIG_FILE_NAMES) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadConfigFile(): Partial<Config> {
  const file = findConfigFile();
  if (!file) return {};

  try {
    const content = fs.readFileSync(file, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const fileConfig = loadConfigFile();

  const sources = process.env.AIDOKU_SOURCES ?? fileConfig.sources;
  const registriesEnv = process.env.AIDOKU_REGISTRIES;
  const registries = registriesEnv
    ? registriesEnv.split(",").map((s) => s.trim())
    : fileConfig.registries ?? [];

  return {
    sources: sources ? path.resolve(sources) : undefined,
    registries,
  };
}

/** Get local sources directory, exits if not configured */
export function requireLocalSources(): string {
  const config = loadConfig();
  if (!config.sources) {
    console.error(`Missing config: sources

Set via environment variable:
  AIDOKU_SOURCES  - path to .aix source files

Or create aidoku.config.json:
  {
    "sources": "./sources"
  }
`);
    process.exit(1);
  }
  return config.sources;
}

/** Require at least one source location (local or registry) */
export function requireSourceConfig(): Config {
  const config = loadConfig();
  if (!config.sources && config.registries.length === 0) {
    console.error(`No source locations configured.

Set via environment variables:
  AIDOKU_SOURCES     - path to local .aix files
  AIDOKU_REGISTRIES  - comma-separated registry URLs

Or create aidoku.config.json:
  {
    "sources": "./sources",
    "registries": ["https://example.com/sources/index.json"]
  }
`);
    process.exit(1);
  }
  return config;
}
