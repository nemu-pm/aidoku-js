/**
 * Final response URL (after redirects) for the HTTP bridges.
 *
 * A CORS proxy hides the target's redirects from the client: the browser only
 * sees the proxy's own URL. nemu's proxy reports where the target's redirect
 * chain ended in `X-Nemu-Final-Url` (listed in Access-Control-Expose-Headers),
 * which takes precedence over anything the transport reports.
 */

/** Response header carrying the final URL of a proxied request (lowercase). */
export const FINAL_URL_HEADER = "x-nemu-final-url";

type HeaderSource = Record<string, string> | { get(name: string): string | null };

/** An absolute http(s) URL, normalised, or undefined. */
function httpUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof headers.get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) return record[key];
  }
  return undefined;
}

/**
 * The response's final URL: the proxy's `X-Nemu-Final-Url` when it holds a
 * valid http(s) URL, else `transportUrl` (the URL the transport itself ended
 * on; pass undefined when that is the proxy's URL rather than the target's).
 * Undefined means "unknown", so callers fall back to the request URL.
 */
export function resolveFinalUrl(
  headers: HeaderSource,
  transportUrl?: string | null
): string | undefined {
  return httpUrl(readHeader(headers, FINAL_URL_HEADER)) ?? httpUrl(transportUrl);
}
