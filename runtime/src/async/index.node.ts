/**
 * Node.js/Bun async runtime
 * 
 * Runs directly on main thread (no Worker needed).
 * Uses sync HTTP via child_process.
 */
import { createLoadSource, type CanvasModule, type SourceInput } from "../runtime";
import { createSyncNodeBridge } from "../http/sync-node";
import {
  createCanvasImports,
  createHostImage,
  getHostImageData,
} from "../imports/canvas.node";
import type { AsyncAidokuSource, AsyncLoadOptions } from "./types";
import {
  extractSettingsDefaults,
  applyManifestDefaults,
  createCfRetry,
  createAsyncWrapper,
} from "./common";

// Re-export types
export type { AsyncAidokuSource, AsyncLoadOptions, CustomFetchFn } from "./types";

// Node canvas module
const nodeCanvasModule: CanvasModule = {
  createCanvasImports,
  createHostImage,
  getHostImageData,
};

// Create sync loadSource
const loadSourceSync = createLoadSource(nodeCanvasModule);

/**
 * Load an Aidoku source asynchronously (Node.js version)
 * 
 * Runs directly on main thread using sync HTTP.
 * All methods return Promises for API consistency.
 * 
 * @param input - AIX bytes or SourceComponents
 * @param sourceKey - Unique identifier for settings/storage
 * @param options - Proxy URL, agent URL, and settings configuration
 */
export async function loadSource(
  input: SourceInput,
  sourceKey: string,
  options: AsyncLoadOptions = {}
): Promise<AsyncAidokuSource> {
  const { proxyUrl, agentUrl, settings } = options;

  // Get user settings (will be merged with defaults)
  const userSettings = settings?.get() ?? {};

  // Create sync HTTP bridge
  // If agentUrl is provided, route all HTTP through the agent
  const httpBridge = createSyncNodeBridge({
    proxyUrl: proxyUrl ? (url) => `${proxyUrl}${encodeURIComponent(url)}` : undefined,
    agentUrl,
  });
  
  if (agentUrl) {
    console.log(`[Aidoku] Using Nemu Agent at ${agentUrl}`);
  }

  // Settings state - populated after loading source
  let currentSettings: Record<string, unknown> = {};

  // Load source with settings getter that uses currentSettings
  const source = await loadSourceSync(input, sourceKey, {
    httpBridge,
    settingsGetter: (key: string) => currentSettings[key],
  });

  // Extract defaults from settings.json (like iOS Aidoku does)
  const settingsDefaults = extractSettingsDefaults(source.settingsJson);
  
  // Merge: settingsJson defaults < manifest defaults < user settings
  currentSettings = { ...settingsDefaults };
  applyManifestDefaults(currentSettings, source.manifest);
  currentSettings = { ...currentSettings, ...userSettings };

  // Now initialize with defaults populated
  source.initialize();

  // Subscribe to settings changes if available
  let unsubscribe: (() => void) | undefined;
  if (settings?.subscribe) {
    unsubscribe = settings.subscribe(() => {
      const newUserSettings = settings.get();
      // Re-apply defaults, then overlay new user settings
      currentSettings = { ...settingsDefaults };
      applyManifestDefaults(currentSettings, source.manifest);
      currentSettings = { ...currentSettings, ...newUserSettings };
    });
  }

  // Create CF retry wrapper
  const cfRetry = createCfRetry(agentUrl);

  // Create and return async wrapper
  return createAsyncWrapper(
    source,
    cfRetry,
    (newSettings) => { currentSettings = newSettings; },
    () => { unsubscribe?.(); }
  );
}
