import { describe, expect, it } from "bun:test";
import { hostFromUrl, isCloudflareChallengeResponse } from "./detect";

const CHALLENGE_PAGE = `<!DOCTYPE html><html><head><title>Just a moment...</title>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
</head><body><div class="cf-turnstile" data-sitekey="x"></div></body></html>`;

const PLAIN_FORBIDDEN_PAGE = `<!DOCTYPE html><html><head><title>403 Forbidden</title>
</head><body><h1>Forbidden</h1><p>You are not allowed to view this page.</p></body></html>`;

describe("isCloudflareChallengeResponse", () => {
  it("detects a 403 challenge page from a Cloudflare edge", () => {
    expect(
      isCloudflareChallengeResponse(403, { server: "cloudflare" }, CHALLENGE_PAGE)
    ).toBe(true);
  });

  it("detects a 503 challenge from the cf-mitigated header without a body", () => {
    expect(isCloudflareChallengeResponse(503, { "cf-mitigated": "challenge" })).toBe(true);
  });

  it("matches headers case-insensitively", () => {
    expect(isCloudflareChallengeResponse(403, { "CF-Mitigated": "Challenge" })).toBe(true);
    expect(
      isCloudflareChallengeResponse(403, { Server: "Cloudflare-nginx" }, CHALLENGE_PAGE)
    ).toBe(true);
  });

  it("detects a challenge from body bytes", () => {
    const body = new TextEncoder().encode(CHALLENGE_PAGE);
    expect(isCloudflareChallengeResponse(403, { server: "cloudflare" }, body)).toBe(true);
  });

  it("detects each challenge marker", () => {
    const markers = [
      "challenge-error-title",
      "challenge-error-text",
      "cf-turnstile-response",
      "<title>Just a moment...</title>",
      "window.__cf_chl_f = 1",
      "window._cf_chl_opt = {}",
      "/cdn-cgi/challenge-platform/h/b/jsd",
    ];

    for (const marker of markers) {
      expect(
        isCloudflareChallengeResponse(503, { server: "cloudflare" }, `<html>${marker}</html>`),
        marker
      ).toBe(true);
    }
  });

  it("treats an ordinary 403 from a Cloudflare-fronted site as a plain rejection", () => {
    expect(
      isCloudflareChallengeResponse(403, { server: "cloudflare" }, PLAIN_FORBIDDEN_PAGE)
    ).toBe(false);
  });

  it("does not guess when the body is unavailable", () => {
    expect(isCloudflareChallengeResponse(403, { server: "cloudflare" })).toBe(false);
  });

  it("never treats a rate limit as a challenge", () => {
    expect(
      isCloudflareChallengeResponse(429, { server: "cloudflare" }, CHALLENGE_PAGE)
    ).toBe(false);
    expect(isCloudflareChallengeResponse(429, { "cf-mitigated": "challenge" })).toBe(false);
  });

  it("ignores successful and unrelated statuses", () => {
    expect(
      isCloudflareChallengeResponse(200, { server: "cloudflare" }, CHALLENGE_PAGE)
    ).toBe(false);
    expect(
      isCloudflareChallengeResponse(500, { "cf-mitigated": "challenge" })
    ).toBe(false);
  });

  it("ignores challenge-looking bodies from other servers", () => {
    expect(isCloudflareChallengeResponse(403, { server: "nginx" }, CHALLENGE_PAGE)).toBe(false);
    expect(isCloudflareChallengeResponse(403, {}, CHALLENGE_PAGE)).toBe(false);
  });

  it("only scans the first 64 KB of the body", () => {
    const padded = `${"a".repeat(64 * 1024)}${CHALLENGE_PAGE}`;
    expect(isCloudflareChallengeResponse(403, { server: "cloudflare" }, padded)).toBe(false);

    const withinWindow = `${"a".repeat(1024)}${CHALLENGE_PAGE}`;
    expect(isCloudflareChallengeResponse(403, { server: "cloudflare" }, withinWindow)).toBe(
      true
    );
  });

  it("decodes invalid UTF-8 bodies without throwing", () => {
    const body = new Uint8Array([0xff, 0xfe, ...new TextEncoder().encode(CHALLENGE_PAGE)]);
    expect(isCloudflareChallengeResponse(403, { server: "cloudflare" }, body)).toBe(true);
  });
});

describe("hostFromUrl", () => {
  it("returns the host of a valid URL", () => {
    expect(hostFromUrl("https://example.com/manga/1?page=2")).toBe("example.com");
    expect(hostFromUrl("https://cdn.example.com:8443/a")).toBe("cdn.example.com:8443");
  });

  it("returns an empty string for an unparseable URL", () => {
    expect(hostFromUrl("not a url")).toBe("");
    expect(hostFromUrl("")).toBe("");
  });
});
