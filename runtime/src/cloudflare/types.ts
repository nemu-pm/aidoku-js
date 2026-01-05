/**
 * Cloudflare bypass types
 */

export interface CfCookie {
  /** Full cookie string: cf_clearance=value */
  cookie: string;
  /** User-Agent that was used (cookie is UA-bound) */
  userAgent: string;
  /** Expiration timestamp (ms) */
  expiresAt: number;
}

export interface CloudflareBypass {
  /**
   * Attempt to solve a Cloudflare challenge for a URL
   * @param url The URL that was blocked
   * @returns Cookie data if successful, null if failed
   */
  solveCfChallenge(url: string): Promise<CfCookie | null>;

  /**
   * Get cached cf_clearance cookie for a domain
   * @param domain The domain to get cookie for
   * @returns Cookie data if cached and valid, null otherwise
   */
  getCfCookie(domain: string): Promise<CfCookie | null>;
}

