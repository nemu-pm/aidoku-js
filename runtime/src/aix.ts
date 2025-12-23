/**
 * AIX package extraction
 * Extracts WASM, manifest, settings, and filters from Aidoku .aix packages
 */
import { unzipSync } from "fflate";
import type { SourceManifest } from "./types";

export interface AixContents {
  wasmBytes: Uint8Array;
  manifest: SourceManifest;
  /** Raw settings.json content (consumer converts to their format) */
  settingsJson?: unknown[];
  /** Raw filters.json content (merged into manifest if manifest.filters is empty) */
  filtersJson?: unknown[];
}

/**
 * Extract contents from an AIX package (zip file)
 */
export function extractAix(aixData: ArrayBuffer | Uint8Array): AixContents {
  const bytes = aixData instanceof Uint8Array ? aixData : new Uint8Array(aixData);
  const files = unzipSync(bytes);

  const manifestData = files["Payload/source.json"];
  const wasmData = files["Payload/main.wasm"];
  const settingsData = files["Payload/settings.json"];
  const filtersData = files["Payload/filters.json"];

  if (!manifestData || !wasmData) {
    throw new Error("Invalid .aix package: missing source.json or main.wasm");
  }

  const manifest: SourceManifest = JSON.parse(
    new TextDecoder().decode(manifestData)
  );

  // Parse filters.json if present
  let filtersJson: unknown[] | undefined;
  if (filtersData) {
    try {
      filtersJson = JSON.parse(new TextDecoder().decode(filtersData));
    } catch {
      // Ignore invalid filters.json
    }
  }

  // Load filters from separate filters.json if manifest doesn't have them
  if (!manifest.filters && filtersJson) {
    manifest.filters = filtersJson as SourceManifest["filters"];
  }

  // Parse settings.json if present
  let settingsJson: unknown[] | undefined;
  if (settingsData) {
    try {
      settingsJson = JSON.parse(new TextDecoder().decode(settingsData));
    } catch {
      // Ignore invalid settings.json
    }
  }

  return {
    wasmBytes: wasmData,
    manifest,
    settingsJson,
    filtersJson,
  };
}

/**
 * Check if data looks like an AIX package (zip file)
 * ZIP files start with PK (0x50 0x4b)
 */
export function isAixPackage(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

