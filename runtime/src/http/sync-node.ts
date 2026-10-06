/**
 * Synchronous HTTP bridge for Node.js/Bun
 * 
 * Uses child_process.spawnSync to execute curl for truly synchronous HTTP.
 * This is safe in Node.js since there's no UI to block.
 * 
 * Optionally routes through Nemu Agent for native TLS fingerprint.
 */
import type { HttpBridge, HttpRequest, HttpResponse } from "../types";
import { spawnSync } from "child_process";

export interface SyncNodeHttpOptions {
  /** Transform URLs (e.g., for proxy) */
  proxyUrl?: (url: string) => string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Get extra headers to inject (e.g., CF cookies, User-Agent) */
  getExtraHeaders?: (url: string) => Record<string, string> | null;
  /** Nemu Agent URL (e.g., "http://localhost:19283") - routes all HTTP through agent */
  agentUrl?: string;
}

const EFFECTIVE_URL_MARKER = "__aidoku_effective_url__:";

/** Index just past the blank line ending the header block at `start`, or -1. */
function findHeaderEnd(output: Uint8Array, start: number): number {
  for (let i = start; i < output.length - 1; i++) {
    if (output[i] === 0x0a && output[i + 1] === 0x0a) return i + 2;
    if (
      i < output.length - 3 &&
      output[i] === 0x0d && output[i + 1] === 0x0a &&
      output[i + 2] === 0x0d && output[i + 3] === 0x0a
    ) {
      return i + 4;
    }
  }
  return -1;
}

const HTTP_PREFIX = [0x48, 0x54, 0x54, 0x50, 0x2f]; // "HTTP/"

function startsWithHttp(output: Uint8Array, at: number): boolean {
  return HTTP_PREFIX.every((byte, i) => output[at + i] === byte);
}

/**
 * Split `curl -s -L -D -` stdout into the final response's status, headers
 * and body. With `-L`, curl dumps one header block per hop (redirects and
 * interim 1xx responses) before the body, so only the last block applies.
 */
export function parseCurlOutput(output: Uint8Array): {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
} {
  let blockStart = 0;
  let blockEnd = findHeaderEnd(output, 0);
  if (blockEnd === -1) {
    // No headers found, treat entire output as body
    return { status: 200, headers: {}, bytes: output };
  }

  let status = 200;
  let headers: Record<string, string> = {};
  for (;;) {
    const headerText = new TextDecoder().decode(output.subarray(blockStart, blockEnd));
    status = 200;
    headers = {};
    for (const line of headerText.split(/\r?\n/)) {
      // Status line: HTTP/1.1 200 OK
      if (line.startsWith("HTTP/")) {
        const match = line.match(/HTTP\/[\d.]+\s+(\d+)/);
        if (match) {
          status = parseInt(match[1], 10);
        }
        continue;
      }

      const colonIdx = line.indexOf(": ");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).toLowerCase();
        const value = line.slice(colonIdx + 2);
        headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
      }
    }

    // Another block follows only after a redirect or an interim response.
    const hopped = (status >= 300 && status < 400) || (status >= 100 && status < 200);
    if (!hopped || !startsWithHttp(output, blockEnd)) break;
    const nextEnd = findHeaderEnd(output, blockEnd);
    if (nextEnd === -1) break;
    blockStart = blockEnd;
    blockEnd = nextEnd;
  }

  return { status, headers, bytes: output.slice(blockEnd) };
}

/** The `%{url_effective}` curl wrote to stderr, if any. */
export function parseEffectiveUrl(stderr: string): string | undefined {
  const idx = stderr.lastIndexOf(EFFECTIVE_URL_MARKER);
  if (idx === -1) return undefined;
  const url = stderr.slice(idx + EFFECTIVE_URL_MARKER.length).split(/\r?\n/)[0].trim();
  return url || undefined;
}

/**
 * Create a synchronous HTTP bridge using curl via child_process
 * Optionally routes through Nemu Agent for native TLS fingerprint
 */
export function createSyncNodeBridge(options: SyncNodeHttpOptions = {}): HttpBridge {
  const { proxyUrl = (url) => url, timeout = 30000, getExtraHeaders, agentUrl } = options;

  // If agentUrl is provided, use agent bridge
  if (agentUrl) {
    return createAgentBridge(agentUrl, timeout, getExtraHeaders);
  }

  return {
    request(req: HttpRequest): HttpResponse {
      const targetUrl = proxyUrl(req.url);
      
      // Build curl arguments
      const args: string[] = [
        "-s", // silent
        "-S", // show errors
        "-L", // follow redirects
        "-X", req.method,
        "--max-time", String(timeout / 1000),
        "-D", "-", // dump headers to stdout
        "-w", `%{stderr}${EFFECTIVE_URL_MARKER}%{url_effective}\n`, // final URL after redirects
      ];

      // Add headers from request
      const headers = { ...req.headers };
      
      // Add extra headers (e.g., CF cookies)
      if (getExtraHeaders) {
        const extra = getExtraHeaders(req.url);
        if (extra) {
          for (const [key, value] of Object.entries(extra)) {
            // Merge cookies if both exist
            if (key.toLowerCase() === "cookie" && headers["Cookie"]) {
              headers["Cookie"] = `${value}; ${headers["Cookie"]}`;
            } else {
              headers[key] = value;
            }
          }
        }
      }
      
      for (const [key, value] of Object.entries(headers)) {
        args.push("-H", `${key}: ${value}`);
      }

      // Add body if present
      if (req.body) {
        args.push("-d", req.body);
      }

      args.push(targetUrl);

      try {
        const result = spawnSync("curl", args, {
          encoding: "buffer",
          timeout,
          maxBuffer: 50 * 1024 * 1024, // 50MB
        });

        if (result.error) {
          console.error("[SyncNodeHttp] curl error:", result.error);
          return {
            status: 0,
            headers: {},
            body: "",
            bytes: null,
          };
        }

        const parsed = parseCurlOutput(new Uint8Array(result.stdout));
        let body = "";
        try {
          body = new TextDecoder("utf-8", { fatal: false }).decode(parsed.bytes);
        } catch {
          // Binary response
        }

        // Through a proxy, curl's effective URL is the proxy's, not the target's.
        const effectiveUrl = targetUrl === req.url
          ? parseEffectiveUrl(result.stderr?.toString("utf-8") ?? "")
          : undefined;

        return {
          status: parsed.status,
          headers: parsed.headers,
          body,
          bytes: parsed.bytes,
          url: effectiveUrl,
        };
      } catch (e) {
        console.error("[SyncNodeHttp] Request failed:", req.url, e);
        return {
          status: 0,
          headers: {},
          body: "",
          bytes: null,
        };
      }
    },
  };
}

/**
 * Create HTTP bridge that routes through Nemu Agent
 * Agent provides native TLS fingerprint and Cloudflare bypass
 */
function createAgentBridge(
  agentUrl: string,
  timeout: number,
  getExtraHeaders?: (url: string) => Record<string, string> | null
): HttpBridge {
  return {
    request(req: HttpRequest): HttpResponse {
      // Build request body for agent
      const headers = { ...req.headers };
      
      // Add extra headers (e.g., CF cookies)
      if (getExtraHeaders) {
        const extra = getExtraHeaders(req.url);
        if (extra) {
          for (const [key, value] of Object.entries(extra)) {
            if (key.toLowerCase() === "cookie" && headers["Cookie"]) {
              headers["Cookie"] = `${value}; ${headers["Cookie"]}`;
            } else {
              headers[key] = value;
            }
          }
        }
      }

      const agentReq: Record<string, unknown> = {
        url: req.url,
        method: req.method,
        headers,
      };
      
      if (req.body) {
        agentReq.body = Buffer.from(req.body).toString("base64");
      }

      try {
        const result = spawnSync("curl", [
          "-s",
          "-X", "POST",
          "-H", "Content-Type: application/json",
          "--max-time", String(timeout / 1000),
          "-d", JSON.stringify(agentReq),
          `${agentUrl}/fetch`,
        ], {
          encoding: "utf-8",
          timeout,
        });

        if (result.error) {
          console.error("[AgentBridge] curl error:", result.error);
          return { status: 0, headers: {}, body: "", bytes: null };
        }

        const data = JSON.parse(result.stdout) as {
          status: number;
          headers: Record<string, string>;
          body: string;
          cf_challenge?: boolean;
          cf_url?: string;
        };

        // Handle CF challenge - trigger WebView solve and retry
        if (data.cf_challenge && data.cf_url) {
          console.log(`[AgentBridge] CF challenge detected for: ${req.url}`);
          console.log(`[AgentBridge] Triggering WebView solve...`);
          
          // Trigger solve via agent
          const solveResult = spawnSync("curl", [
            "-s", "-X", "POST",
            "-H", "Content-Type: application/json",
            "-d", JSON.stringify({ url: data.cf_url }),
            `${agentUrl}/solve-cf`,
          ], { encoding: "utf-8", timeout: 5000 });
          
          if (solveResult.stdout) {
            try {
              const solveData = JSON.parse(solveResult.stdout);
              if (solveData.started && solveData.window_id) {
                console.log(`[AgentBridge] CF solve started: ${solveData.window_id}`);
                
                // Poll for completion (up to 60s)
                for (let i = 0; i < 60; i++) {
                  const pollResult = spawnSync("curl", [
                    "-s",
                    `${agentUrl}/solve-cf/${solveData.window_id}`,
                  ], { encoding: "utf-8", timeout: 2000 });
                  
                  if (pollResult.stdout) {
                    try {
                      const pollData = JSON.parse(pollResult.stdout);
                      if (pollData.status === "solved") {
                        console.log(`[AgentBridge] CF challenge solved!`);
                        // Retry the original request
                        return this.request(req);
                      } else if (pollData.status === "failed" || pollData.status === "closed") {
                        console.log(`[AgentBridge] CF solve failed: ${pollData.status}`);
                        break;
                      }
                    } catch {}
                  }
                  // Wait 1s before next poll
                  spawnSync("sleep", ["1"]);
                }
              }
            } catch {}
          }
          
          // CF solve failed/timed out - return a response the challenge
          // detector recognises, so net.send raises CloudflareBlockedError.
          const body = `Cloudflare challenge detected for ${req.url} (status ${data.status})`;
          return {
            status: 403,
            headers: { server: "cloudflare", "cf-mitigated": "challenge" },
            body,
            bytes: new TextEncoder().encode(body),
          };
        }

        // Decode base64 body
        const bytes = data.body
          ? Uint8Array.from(Buffer.from(data.body, "base64"))
          : new Uint8Array(0);

        // Normalize header keys to lowercase
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(data.headers || {})) {
          respHeaders[k.toLowerCase()] = v;
        }

        return {
          status: data.status,
          headers: respHeaders,
          body: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
          bytes,
        };
      } catch (e) {
        console.error("[AgentBridge] Request failed:", req.url, e);
        return { status: 0, headers: {}, body: "", bytes: null };
      }
    },
  };
}

