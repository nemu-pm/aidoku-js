/**
 * net namespace - HTTP request handling using HttpBridge
 * The HttpBridge is provided by the consumer (e.g., sync XHR in a Web Worker)
 */
import { load as cheerioLoad, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { GlobalStore } from "../global-store";
import type { HttpBridge } from "../types";

// Extended Cheerio type with API reference
interface CheerioWithApi extends Cheerio<AnyNode> {
  _cheerioApi?: CheerioAPI;
}

// RequestError codes matching aidoku-rs
const RequestError = {
  InvalidDescriptor: -1,
  InvalidString: -2,
  InvalidMethod: -3,
  InvalidUrl: -4,
  InvalidHtml: -5,
  InvalidBufferSize: -6,
  MissingData: -7,
  MissingResponse: -8,
  MissingUrl: -9,
  RequestError: -10,
  FailedMemoryWrite: -11,
  NotAnImage: -12,
} as const;

// Default User-Agent for requests
const DEFAULT_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export function createNetImports(store: GlobalStore, httpBridge: HttpBridge) {
  return {
    init: (method: number): number => {
      const id = store.createRequest(method);
      // Add default User-Agent like reference runner
      const req = store.requests.get(id);
      if (req) {
        req.headers["User-Agent"] = DEFAULT_USER_AGENT;
      }
      return id;
    },

    send: (descriptor: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (!req.url) return RequestError.MissingUrl;

      // Add stored cookies for this URL (like Swift's HTTPCookieStorage)
      const storedCookies = store.getCookiesForUrl(req.url);
      if (storedCookies) {
        // Merge with existing cookies if any (stored cookies first, then request's existing)
        const existingCookie = req.headers["Cookie"];
        req.headers["Cookie"] = existingCookie
          ? `${storedCookies}; ${existingCookie}`
          : storedCookies;
      }

      try {
        // Use the HttpBridge to make the request
        const response = httpBridge.request({
          url: req.url,
          method: req.method || "GET",
          headers: req.headers,
          body: req.body ? new TextDecoder().decode(req.body) : null,
        });

        // Parse response headers
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          const headerKey = key.toLowerCase();
          // Join multiple values with comma (like reference runner)
          if (responseHeaders[headerKey]) {
            responseHeaders[headerKey] += ", " + value;
          } else {
            responseHeaders[headerKey] = value;
          }
        }

        // Store cookies from response (like Swift's HTTPCookieStorage)
        store.storeCookiesFromResponse(req.url, responseHeaders);

        // Get data as bytes
        let data: Uint8Array;
        if (response.bytes) {
          data = response.bytes;
        } else {
          data = new TextEncoder().encode(response.body);
        }

        req.response = {
          data,
          statusCode: response.status,
          headers: responseHeaders,
          bytesRead: 0,
        };
        return 0;
      } catch (error) {
        console.error("[net.send] Request failed:", error);
        req.response = {
          data: new Uint8Array(0),
          statusCode: 0,
          headers: {},
          bytesRead: 0,
        };
        return RequestError.RequestError;
      }
    },

    // Send multiple requests in parallel (simplified - just sequential for now)
    send_all: (idsPtr: number, len: number): number => {
      // Read the array of request IDs
      const ids = store.readBytes(idsPtr, len * 4);
      if (!ids) return -1;

      const view = new DataView(ids.buffer, ids.byteOffset);
      let hasError = false;

      for (let i = 0; i < len; i++) {
        const rid = view.getInt32(i * 4, true);
        const result = createNetImports(store, httpBridge).send(rid);
        if (result !== 0) {
          // Store error code back in the array
          view.setInt32(i * 4, result, true);
          hasError = true;
        }
      }

      // Write back the results
      store.writeBytes(ids, idsPtr);

      return hasError ? -1 : 0;
    },

    // aidoku-rs: set_url(rid, ptr, len) -> FFIResult
    set_url: (descriptor: number, urlPtr: number, urlLen: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (urlLen <= 0) return RequestError.InvalidString;

      const url = store.readString(urlPtr, urlLen);
      if (!url) return RequestError.InvalidString;

      // Validate URL
      try {
        new URL(url);
      } catch {
        return RequestError.InvalidUrl;
      }

      req.url = url;
      return 0;
    },

    // aidoku-rs: set_header(rid, key_ptr, key_len, val_ptr, val_len) -> FFIResult
    set_header: (
      descriptor: number,
      keyPtr: number,
      keyLen: number,
      valuePtr: number,
      valueLen: number
    ): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (keyLen <= 0) return RequestError.InvalidString;

      const key = store.readString(keyPtr, keyLen);
      if (!key) return RequestError.InvalidString;

      const value = valueLen > 0 ? store.readString(valuePtr, valueLen) : "";
      req.headers[key] = value || "";
      return 0;
    },

    // aidoku-rs: set_body(rid, ptr, len) -> FFIResult
    set_body: (descriptor: number, bodyPtr: number, bodyLen: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;

      if (bodyLen > 0) {
        const body = store.readBytes(bodyPtr, bodyLen);
        if (!body) return RequestError.FailedMemoryWrite;
        req.body = body;
      }
      return 0;
    },

    // Get the length of response data
    data_len: (descriptor: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (!req.response) return RequestError.MissingResponse;
      if (!req.response.data) return RequestError.MissingData;
      return req.response.data.length;
    },

    // Read response data into WASM memory
    read_data: (descriptor: number, bufferPtr: number, size: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (!req.response) return RequestError.MissingResponse;
      if (!req.response.data) return RequestError.MissingData;

      const data = req.response.data;
      if (size > data.length) return RequestError.InvalidBufferSize;

      try {
        store.writeBytes(data.slice(0, size), bufferPtr);
        return 0;
      } catch {
        return RequestError.FailedMemoryWrite;
      }
    },

    // Get image from response
    get_image: (descriptor: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (!req.response) return RequestError.MissingResponse;
      if (!req.response.data) return RequestError.MissingData;
      // TODO: Implement proper image handling
      return RequestError.NotAnImage;
    },

    // Get response header value (returns RID to string, joined with comma for multi-value)
    get_header: (descriptor: number, keyPtr: number, keyLen: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (keyLen <= 0) return RequestError.InvalidString;

      const key = store.readString(keyPtr, keyLen);
      if (!key) return RequestError.InvalidString;
      if (!req.response?.headers) return RequestError.MissingResponse;

      const value = req.response.headers[key.toLowerCase()];
      if (!value) return RequestError.MissingData;
      return store.storeStdValue(value);
    },

    get_status_code: (descriptor: number): number => {
      if (descriptor < 0) return RequestError.InvalidDescriptor;
      const req = store.requests.get(descriptor);
      if (!req) return RequestError.InvalidDescriptor;
      if (!req.response) return RequestError.MissingResponse;
      return req.response.statusCode ?? 0;
    },

    html: (descriptor: number): number => {
      const req = store.requests.get(descriptor);
      if (!req?.response?.data) {
        return -7;
      }

      try {
        const text = new TextDecoder().decode(req.response.data);
        const $ = cheerioLoad(text, { baseURI: req.url });
        const root = $.root() as CheerioWithApi;
        root._cheerioApi = $;
        const htmlDescriptor = store.storeStdValue(root);
        return htmlDescriptor;
      } catch (e) {
        console.error("[net.html] Parse error:", e);
        return -5; // InvalidHtml
      }
    },

    json: (descriptor: number): number => {
      const req = store.requests.get(descriptor);
      if (!req?.response?.data) {
        return -7;
      }

      try {
        const text = new TextDecoder().decode(req.response.data);
        const parsed = JSON.parse(text);
        return store.storeStdValue(parsed);
      } catch (e) {
        console.error("[net.json] Parse error:", e);
        return -5; // ParseError
      }
    },

    set_rate_limit: (_permits: number, _period: number, _unit: number): void => {
      // Rate limiting is not strictly enforced in this runtime
    },

    set_rate_limit_period: (_permits: number, _period: number): void => {
      // Rate limiting is not strictly enforced in this runtime
    },

    // ============ OLD ABI (legacy sources like aidoku-zh) ============

    // Close/cleanup a request
    close: (descriptor: number): void => {
      store.requests.delete(descriptor);
    },

    // Get size of response data (OLD ABI - returns REMAINING bytes, uses bytesRead)
    // Swift reference: return data.length - bytesRead
    get_data_size: (descriptor: number): number => {
      if (descriptor < 0) return -1;
      const req = store.requests.get(descriptor);
      if (!req?.response?.data) return RequestError.MissingData;
      // Return remaining bytes (total - already read)
      return req.response.data.length - req.response.bytesRead;
    },

    // Read response data (OLD ABI - streaming compatible, advances bytesRead)
    // Swift reference: copy from bytesRead position, increment bytesRead
    get_data: (descriptor: number, bufferPtr: number, size: number): void => {
      if (descriptor < 0 || size <= 0) return;
      const req = store.requests.get(descriptor);
      if (!req?.response?.data) return;

      const data = req.response.data;
      const bytesRead = req.response.bytesRead;

      // Guard bounds like Swift: only read if bytesRead + size <= data.length
      if (bytesRead + size > data.length) {
        return;
      }

      // Copy bytes starting at bytesRead (not from 0)
      store.writeBytes(data.slice(bytesRead, bytesRead + size), bufferPtr);

      // Increment bytesRead
      req.response.bytesRead += size;
    },
  };
}

