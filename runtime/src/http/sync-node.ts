/**
 * Synchronous HTTP bridge for Node.js/Bun
 * 
 * Uses child_process.spawnSync to execute curl for truly synchronous HTTP.
 * This is safe in Node.js since there's no UI to block.
 */
import type { HttpBridge, HttpRequest, HttpResponse } from "../types";
import { spawnSync } from "child_process";

export interface SyncNodeHttpOptions {
  /** Transform URLs (e.g., for proxy) */
  proxyUrl?: (url: string) => string;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Create a synchronous HTTP bridge using curl via child_process
 */
export function createSyncNodeBridge(options: SyncNodeHttpOptions = {}): HttpBridge {
  const { proxyUrl = (url) => url, timeout = 30000 } = options;

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
      ];

      // Add headers
      for (const [key, value] of Object.entries(req.headers)) {
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

        const output = result.stdout;
        
        // Parse curl output: headers followed by blank line, then body
        // Find the blank line separating headers from body
        let headerEndIdx = -1;
        for (let i = 0; i < output.length - 3; i++) {
          if (output[i] === 0x0d && output[i + 1] === 0x0a && 
              output[i + 2] === 0x0d && output[i + 3] === 0x0a) {
            headerEndIdx = i;
            break;
          }
          // Also check for \n\n (Unix line endings)
          if (output[i] === 0x0a && output[i + 1] === 0x0a) {
            headerEndIdx = i;
            break;
          }
        }

        if (headerEndIdx === -1) {
          // No headers found, treat entire output as body
          const bytes = new Uint8Array(output);
          return {
            status: 200,
            headers: {},
            body: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
            bytes,
          };
        }

        // Parse headers
        const headerText = output.slice(0, headerEndIdx).toString("utf-8");
        const headers: Record<string, string> = {};
        let status = 200;

        const headerLines = headerText.split(/\r?\n/);
        for (const line of headerLines) {
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

        // Extract body (skip \r\n\r\n or \n\n)
        const bodyStart = output[headerEndIdx] === 0x0d ? headerEndIdx + 4 : headerEndIdx + 2;
        const bytes = new Uint8Array(output.slice(bodyStart));
        
        let body = "";
        try {
          body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        } catch {
          // Binary response
        }

        return {
          status,
          headers,
          body,
          bytes,
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

