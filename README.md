# aidoku-js

Runtime for loading and executing [Aidoku](https://github.com/Aidoku/Aidoku) WASM sources in JavaScript environments.

## What is this?

Aidoku sources are WebAssembly modules that provide manga content from various websites. This runtime allows you to load and execute these sources in any JavaScript environment (browsers, Node.js, Bun, etc.).

## Installation

```bash
npm install @aidoku-js/runtime
# or
bun add @aidoku-js/runtime
```

## Usage

```typescript
import { createRuntime, type HttpBridge, type SourceManifest } from '@aidoku-js/runtime';

// Implement sync HTTP bridge (typically in a Web Worker)
const httpBridge: HttpBridge = {
  request(req) {
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url, false); // sync
    for (const [key, value] of Object.entries(req.headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.send(req.body);
    return {
      status: xhr.status,
      headers: parseHeaders(xhr.getAllResponseHeaders()),
      body: xhr.responseText,
      bytes: null,
    };
  }
};

// Create runtime
const runtime = createRuntime(httpBridge);

// Load a source
const wasmBytes = await fetch('https://example.com/source.wasm').then(r => r.arrayBuffer());
const manifest: SourceManifest = { /* ... */ };
const source = runtime.loadSource(wasmBytes, manifest, (key) => settings[key]);

// Initialize and use
source.initialize();
const results = source.getSearchMangaList('one piece', 1, []);
console.log(results.entries);
```

## Web Worker Usage (Recommended for Browsers)

Since WASM sources use synchronous HTTP requests, they should run in a Web Worker to avoid blocking the main thread:

```typescript
// worker.ts
import { createRuntime } from '@aidoku-js/runtime';

const runtime = createRuntime({
  request(req) {
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url, false);
    // ...
    return { status: xhr.status, body: xhr.responseText, headers: {}, bytes: null };
  }
});

// Expose via Comlink or postMessage
```

## API

### `createRuntime(httpBridge: HttpBridge): AidokuRuntime`

Creates a runtime instance with the given HTTP bridge.

### `AidokuRuntime.loadSource(wasmBytes, manifest, settingsGetter): SourceInstance`

Loads a WASM source and returns an instance.

### `SourceInstance` Methods

- `initialize()` - Initialize the source
- `getSearchMangaList(query, page, filters)` - Search for manga
- `getMangaDetails(manga)` - Get manga details
- `getChapterList(manga)` - Get chapters for a manga
- `getPageList(manga, chapter)` - Get pages for a chapter
- `getFilters()` - Get available filters
- `getListings()` - Get available listings
- `getHome()` - Get home layout (if supported)
- `modifyImageRequest(url, context)` - Get modified image request headers
- `processPageImage(...)` - Process/descramble page images

## License

MIT


