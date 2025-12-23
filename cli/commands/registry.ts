import { buildCommand, buildRouteMap } from "@stricli/core";
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import { loadConfig } from "../config";

const CONFIG_FILE = "aidoku.config.json";

interface ConfigFile {
  sources?: string;
  registries?: string[];
}

function getConfigPath(): string {
  return path.join(process.cwd(), CONFIG_FILE);
}

function readConfigFile(): ConfigFile {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfigFile(config: ConfigFile): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

const add = buildCommand({
  docs: {
    brief: "Add a registry URL",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Registry URL",
          parse: String,
          placeholder: "url",
        },
      ],
    },
  },
  func: async (_flags: object, url: string) => {
    const config = readConfigFile();
    const registries = config.registries ?? [];

    if (registries.includes(url)) {
      console.log(pc.yellow(`Registry already exists: ${url}`));
      return;
    }

    registries.push(url);
    config.registries = registries;
    writeConfigFile(config);

    console.log(pc.green(`✓ Added registry: ${url}`));
    console.log(pc.dim(`  Saved to ${CONFIG_FILE}`));
  },
});

const remove = buildCommand({
  docs: {
    brief: "Remove a registry URL",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Registry URL (or partial match)",
          parse: String,
          placeholder: "url",
        },
      ],
    },
  },
  func: async (_flags: object, url: string) => {
    const config = readConfigFile();
    const registries = config.registries ?? [];

    // Try exact match first, then partial
    let idx = registries.indexOf(url);
    if (idx === -1) {
      idx = registries.findIndex((r) => r.includes(url));
    }

    if (idx === -1) {
      console.log(pc.red(`Registry not found: ${url}`));
      if (registries.length > 0) {
        console.log(pc.dim("\nConfigured registries:"));
        for (const r of registries) {
          console.log(pc.dim(`  ${r}`));
        }
      }
      return;
    }

    const removed = registries.splice(idx, 1)[0];
    config.registries = registries;
    writeConfigFile(config);

    console.log(pc.green(`✓ Removed registry: ${removed}`));
  },
});

const list = buildCommand({
  docs: {
    brief: "List configured registries",
  },
  parameters: {},
  func: async () => {
    const config = loadConfig();

    console.log(pc.bold("\nConfigured Registries:\n"));

    if (config.registries.length === 0) {
      console.log(pc.dim("  (none)"));
      console.log(pc.dim("\n  Add one with: aidoku registry add <url>"));
      return;
    }

    for (const url of config.registries) {
      console.log(`  ${pc.cyan("•")} ${url}`);
    }

    if (config.sources) {
      console.log(pc.dim(`\nLocal sources: ${config.sources}`));
    }
  },
});

export const registry = buildRouteMap({
  routes: {
    add,
    remove,
    list,
  },
  docs: {
    brief: "Manage source registries",
  },
});

