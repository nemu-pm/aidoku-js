# @nemu.pm/aidoku-runtime

Runtime for loading and executing Aidoku WASM sources in JavaScript environments.

## Install

```bash
bun add @nemu.pm/aidoku-runtime
# or
npm install @nemu.pm/aidoku-runtime
```

## Usage

```typescript
import { AidokuRuntime } from "@nemu.pm/aidoku-runtime";

const runtime = new AidokuRuntime();
const source = await runtime.loadSource(wasmBuffer, sourceInfo);

const mangas = await source.getMangaList([], 1);
```

## Source error codes

A source function that fails returns a negative code. `AidokuResultErrorCode`
maps them: `Message` (-1), `Unimplemented` (-2), `RequestError` (-3),
`HtmlError` (-4), `JsError` (-5), `CanvasError` (-6), `Utf8Error` (-7),
`JsonParseError` (-8), `DeserializeError` (-9). Errors raised for these are
`AidokuResultError`, which carries the numeric `code`; for `Message` the
`message` is the text the source returned.

`getSearchMangaList`, `getMangaDetails`, `getChapterList`, `getPageList`,
`getMangaListForListing` and `getHome` reject with `AidokuResultError` instead
of reporting an empty result, so a failure is distinguishable from "nothing
found":

```typescript
try {
  await source.getChapterList(manga);
} catch (e) {
  if (e instanceof AidokuResultError && e.code === AidokuResultErrorCode.Unimplemented) {
    // the source does not implement this
  }
}
```

`getFilters` and `getListings` stay lenient and fall back to an empty list.

## Image processing

Sources may process page and cover images:

```typescript
if (await source.hasImageProcessor()) {
  const page = await source.processPageImage(
    bytes, context, requestUrl, requestHeaders, status, responseHeaders
  );
}

if (await source.hasCoverImageProcessor()) {
  // Covers take no page context
  const cover = await source.processCoverImage(
    bytes, requestUrl, requestHeaders, status, responseHeaders
  );
}
```

Both resolve to processed PNG bytes, or `null` when the source declines.

## Cloudflare challenges

A blocked request throws `CloudflareBlockedError` (`url`, `status`, `host`,
`userAgent`). Pass `cloudflareSolver` to `loadSource` to clear challenges and
retry; concurrent requests to one host share a single solve, and a call gets up
to two solve-and-retry rounds before the original error is rethrown. Both this
error and `AidokuResultError` keep their class and fields across the browser
build's worker boundary.

```typescript
const source = await loadSource(aixBytes, "my-source", {
  cloudflareSolver: async ({ url, host, userAgent }) => {
    // Present the challenge to the user, resolve true once cleared
    return true;
  },
});
```

`isCloudflareChallengeResponse(status, headers, body?)` is exported for hosts
that do their own HTTP.

## Default User-Agent

Every request a source makes — and the headers `modifyImageRequest` returns —
carry `DEFAULT_USER_AGENT` unless the source sets its own `User-Agent`. A
Cloudflare clearance cookie is bound to the exact User-Agent that solved the
challenge, so a host that solves challenges in a platform WebView should pass
that WebView's User-Agent:

```typescript
const source = await loadSource(aixBytes, "my-source", {
  defaultUserAgent: navigator.userAgent,
});

await source.getDefaultUserAgent(); // the UA actually in use
```

The value is trimmed; empty strings, values over 512 characters and values
carrying control characters fall back to the exported `DEFAULT_USER_AGENT`. The
sync API takes the same option and exposes `source.defaultUserAgent`.

## Unsupported imports

Webviews are not available, so these `js` imports exist for instantiation only
and always fail: `webview_create`, `webview_set_rule_list`, `webview_load`,
`webview_load_html`, `webview_wait_for_load`, `webview_eval`,
`webview_eval_async`, `webview_add_user_script`, `webview_get_cookies`,
`webview_delete_cookie`. `context_eval_async` behaves like `context_eval`,
since context evaluation here is synchronous.

## Documentation

See the main repository for full documentation: https://github.com/nemu-pm/aidoku-js

## License

MIT

