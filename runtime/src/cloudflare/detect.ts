/**
 * Cloudflare challenge detection
 *
 * A challenge page is not the same thing as an ordinary rejection from a
 * Cloudflare-fronted site: plain 403s (blocked path, bad token) and 429s
 * (rate limit) carry the same `server: cloudflare` header but cannot be
 * solved by a browser challenge, so retrying them is pointless.
 */

/** Details about a detected challenge, handed to a solver. */
export interface CloudflareChallengeInfo {
  /** URL that returned the challenge */
  url: string;
  /** HTTP status of the challenge response */
  status: number;
  /** Host of the challenged URL (challenges and clearances are per-host) */
  host: string;
  /** User-Agent used for the request (cf_clearance cookies are UA-bound) */
  userAgent?: string;
}

/**
 * Solve a Cloudflare challenge for the given request.
 * Resolves true if the challenge was cleared and the request can be retried.
 */
export type CloudflareChallengeSolver = (
  info: CloudflareChallengeInfo
) => Promise<boolean>;

/** Statuses Cloudflare uses to serve an interactive challenge. */
const CHALLENGE_STATUSES = [403, 503];

/** Server header values that identify a Cloudflare edge. */
const CLOUDFLARE_SERVERS = ["cloudflare", "cloudflare-nginx"];

/** Markers present in challenge page bodies (compared lowercased). */
const CHALLENGE_MARKERS = [
  "challenge-error-title",
  "challenge-error-text",
  "cf-turnstile-response",
  "<title>just a moment...",
  "__cf_chl_",
  "cf_chl_opt",
  "/cdn-cgi/challenge-platform/",
];

/** Only the start of a body is scanned; challenge markup is in the head. */
const MAX_BODY_SCAN_BYTES = 64 * 1024;

/** Look up a header without caring about its casing. */
function getHeader(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value ?? "";
    }
  }
  return "";
}

/** Decode the leading bytes of a body, replacing invalid sequences. */
function decodeBodyStart(body: Uint8Array | string): string {
  if (typeof body === "string") {
    return body.slice(0, MAX_BODY_SCAN_BYTES).toLowerCase();
  }
  const head = body.subarray(0, MAX_BODY_SCAN_BYTES);
  return new TextDecoder("utf-8", { fatal: false }).decode(head).toLowerCase();
}

/**
 * Check whether a response is a Cloudflare challenge that a solver could clear.
 *
 * True when the status is 403 or 503 and either the `cf-mitigated` header says
 * `challenge`, or the response comes from a Cloudflare edge and its body
 * contains challenge markup. Header names and values are matched
 * case-insensitively; 429 is a rate limit, never a challenge.
 */
export function isCloudflareChallengeResponse(
  status: number,
  headers: Record<string, string>,
  body?: Uint8Array | string
): boolean {
  if (!CHALLENGE_STATUSES.includes(status)) {
    return false;
  }

  const mitigated = getHeader(headers, "cf-mitigated").trim().toLowerCase();
  if (mitigated === "challenge") {
    return true;
  }

  const server = getHeader(headers, "server").trim().toLowerCase();
  if (!CLOUDFLARE_SERVERS.includes(server)) {
    return false;
  }

  if (body === undefined) {
    return false;
  }

  const text = decodeBodyStart(body);
  return CHALLENGE_MARKERS.some((marker) => text.includes(marker));
}

/** Host of a URL, or an empty string if it cannot be parsed. */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
