/**
 * Synchronous XHR HTTP bridge for browser Workers
 * 
 * IMPORTANT: This must only be used inside a Web Worker!
 * Sync XHR on the main thread blocks the UI.
 */
import type { HttpBridge, HttpRequest, HttpResponse } from "../types";

export interface SyncXhrOptions {
  /** Transform URLs (e.g., for CORS proxy) */
  proxyUrl?: (url: string) => string;
  /** Custom headers to add to all requests */
  defaultHeaders?: Record<string, string>;
}

/**
 * Create a synchronous XHR HTTP bridge
 * Used inside Web Workers where blocking is acceptable
 */
export function createSyncXhrBridge(options: SyncXhrOptions = {}): HttpBridge {
  const { proxyUrl = (url) => url, defaultHeaders = {} } = options;

  return {
    request(req: HttpRequest): HttpResponse {
      const xhr = new XMLHttpRequest();
      const targetUrl = proxyUrl(req.url);
      
      xhr.open(req.method, targetUrl, false); // false = synchronous
      xhr.responseType = "arraybuffer";

      // Set default headers
      for (const [key, value] of Object.entries(defaultHeaders)) {
        xhr.setRequestHeader(key, value);
      }

      // Set request headers (may be prefixed for proxy)
      for (const [key, value] of Object.entries(req.headers)) {
        // If using a proxy, prefix headers so proxy can forward them
        const headerKey = targetUrl !== req.url ? `x-proxy-${key}` : key;
        xhr.setRequestHeader(headerKey, value);
      }

      try {
        xhr.send(req.body);

        // Parse response headers
        const headers: Record<string, string> = {};
        xhr.getAllResponseHeaders().split("\r\n").forEach((line) => {
          const idx = line.indexOf(": ");
          if (idx > 0) {
            const key = line.slice(0, idx).toLowerCase();
            const value = line.slice(idx + 2);
            headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
          }
        });

        const bytes = new Uint8Array(xhr.response as ArrayBuffer);
        
        // Try to decode as text for body (UTF-8)
        let body = "";
        try {
          body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        } catch {
          // Binary response, body stays empty
        }

        return {
          status: xhr.status,
          headers,
          body,
          bytes,
        };
      } catch (e) {
        console.error("[SyncXHR] Request failed:", req.url, e);
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

