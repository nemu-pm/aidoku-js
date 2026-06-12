/**
 * Check that the runtime's wasm import object covers every import required
 * by a set of real .aix main.wasm binaries.
 *
 * Usage: bun scripts/check-import-coverage.ts <wasm-file> [...more]
 */
import { GlobalStore } from "../src/global-store";
import {
  createStdImports,
  createNetImports,
  createHtmlImports,
  createJsonImports,
  createDefaultsImports,
  createEnvImports,
  createAidokuImports,
  createJsImports,
  createCanvasImports,
} from "../src/imports/index";


const store = new GlobalStore("coverage-check");
const settings: Record<string, unknown> = {};

const importObject: Record<string, Record<string, unknown>> = {
  env: createEnvImports(store) as Record<string, unknown>,
  std: createStdImports(store) as Record<string, unknown>,
  net: createNetImports(store, {
    request: async () => ({ data: new Uint8Array(), statusCode: 200, headers: {} }),
  } as never) as Record<string, unknown>,
  html: createHtmlImports(store) as Record<string, unknown>,
  json: createJsonImports(store) as Record<string, unknown>,
  defaults: createDefaultsImports(
    store,
    (key: string) => settings[key],
    (key: string, value: unknown) => {
      settings[key] = value;
    }
  ) as Record<string, unknown>,
  aidoku: createAidokuImports(store) as Record<string, unknown>,
  canvas: createCanvasImports(store) as Record<string, unknown>,
  js: createJsImports(store) as Record<string, unknown>,
};

let missingTotal = 0;
for (const file of process.argv.slice(2)) {
  const bytes = await Bun.file(file).arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  const missing = WebAssembly.Module.imports(module).filter(
    (imp) => imp.kind === "function" && typeof importObject[imp.module]?.[imp.name] !== "function"
  );
  if (missing.length > 0) {
    missingTotal += missing.length;
    console.log(`${file}:`);
    for (const imp of missing) console.log(`  MISSING ${imp.module}.${imp.name}`);
  }
}

store.destroy();
if (missingTotal === 0) {
  console.log(`OK: all imports covered for ${process.argv.length - 2} module(s)`);
} else {
  console.log(`${missingTotal} missing import(s)`);
  process.exit(1);
}
