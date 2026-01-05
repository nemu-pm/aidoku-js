/**
 * Synchronous HTTP bridge using SharedArrayBuffer + Atomics
 * 
 * Worker blocks with Atomics.wait, main thread fetches via extension/proxy,
 * writes response to SharedArrayBuffer, signals with Atomics.notify.
 * 
 * SharedArrayBuffer layout:
 * - [0]: Control signal (0 = waiting, 1 = response ready)
 * - [1]: Response status code
 * - [2]: Response body length (in bytes)
 * - [3]: Headers JSON length (in bytes)
 * - [4...]: Response body + headers JSON (as UTF-8 bytes)
 * 
 * Requires COOP/COEP headers for SharedArrayBuffer support.
 */
import type { HttpBridge, HttpRequest, HttpResponse } from "../types";

// Message types for worker <-> main thread communication
export interface SabHttpRequest {
  type: "HTTP_REQUEST";
  id: number;
  request: HttpRequest;
}

// Buffer layout offsets (Int32 indices)
const CONTROL_INDEX = 0;
const STATUS_INDEX = 1;
const BODY_LENGTH_INDEX = 2;
const HEADERS_LENGTH_INDEX = 3;
const DATA_START_INDEX = 4; // Start of body + headers data

// Default buffer size: 10MB for response data
const DEFAULT_BUFFER_SIZE = 10 * 1024 * 1024;

/** Extended HttpBridge with SAB-specific methods */
export interface SabHttpBridge extends HttpBridge {
  /** Get the SharedArrayBuffer for passing to worker */
  getBuffer(): SharedArrayBuffer;
}

/**
 * Create the worker-side HTTP bridge
 * 
 * @param postMessage - Function to send messages to main thread
 * @param sharedBuffer - SharedArrayBuffer for data exchange
 */
export function createSabWorkerBridge(
  postMessage: (msg: SabHttpRequest) => void,
  sharedBuffer: SharedArrayBuffer
): SabHttpBridge {
  const control = new Int32Array(sharedBuffer);
  const dataView = new Uint8Array(sharedBuffer);
  let requestId = 0;
  
  return {
    getBuffer() {
      return sharedBuffer;
    },
    
    request(req: HttpRequest): HttpResponse {
      const id = ++requestId;
      console.log(`[SabHttp] Request #${id}: ${req.method} ${req.url}`);
      
      // Reset control to 0 (waiting state)
      Atomics.store(control, CONTROL_INDEX, 0);
      
      // Send request to main thread
      postMessage({
        type: "HTTP_REQUEST",
        id,
        request: req,
      });
      
      // Block until main thread signals (value changes from 0)
      // Timeout after 60 seconds
      const result = Atomics.wait(control, CONTROL_INDEX, 0, 60000);
      
      if (result === "timed-out") {
        console.error("[SabHttp] Request timed out:", req.url);
        return {
          status: 0,
          headers: {},
          body: "",
          bytes: null,
        };
      }
      
      // Read response from SharedArrayBuffer
      const status = Atomics.load(control, STATUS_INDEX);
      const bodyLength = Atomics.load(control, BODY_LENGTH_INDEX);
      const headersLength = Atomics.load(control, HEADERS_LENGTH_INDEX);
      
      if (status === 0 && bodyLength === 0) {
        console.error("[SabHttp] Empty response for:", req.url);
        return {
          status: 0,
          headers: {},
          body: "",
          bytes: null,
        };
      }
      
      // Read body bytes
      const dataStart = DATA_START_INDEX * 4; // Convert Int32 index to byte offset
      const bodyBytes = new Uint8Array(bodyLength);
      bodyBytes.set(dataView.slice(dataStart, dataStart + bodyLength));
      
      // Read and parse headers JSON
      let headers: Record<string, string> = {};
      if (headersLength > 0) {
        const headersStart = dataStart + bodyLength;
        const headersBytes = dataView.slice(headersStart, headersStart + headersLength);
        try {
          const headersJson = new TextDecoder().decode(headersBytes);
          headers = JSON.parse(headersJson);
        } catch (e) {
          console.error("[SabHttp] Failed to parse headers:", e);
        }
      }
      
      // Decode body as text
      let body = "";
      try {
        body = new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes);
      } catch {
        // Binary response
      }
      
      console.log(`[SabHttp] Response #${id}: status=${status}, bodyLen=${bodyLength}, body preview: ${body.substring(0, 100)}`);
      
      // Debug: log full body for page list requests
      if (req.url.includes('/read/') && req.url.endsWith('.html')) {
        console.log(`[SabHttp] FULL PAGE BODY for ${req.url}:\n`, body);
      }
      
      return {
        status,
        headers,
        body,
        bytes: bodyBytes,
      };
    },
  };
}

/**
 * Create SharedArrayBuffer for SAB HTTP bridge
 * 
 * @param size - Buffer size in bytes (default 10MB)
 */
export function createSabBuffer(size: number = DEFAULT_BUFFER_SIZE): SharedArrayBuffer {
  return new SharedArrayBuffer(size);
}

/**
 * Main thread handler for SAB HTTP requests
 * 
 * @param fetchFn - Function to perform the actual fetch (extension or fallback)
 * @param sharedBuffer - SharedArrayBuffer for response data
 */
export function createSabMainThreadHandler(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  sharedBuffer: SharedArrayBuffer
) {
  const control = new Int32Array(sharedBuffer);
  const dataView = new Uint8Array(sharedBuffer);
  
  return async (msg: SabHttpRequest) => {
    const { request } = msg;
    
    try {
      // Build fetch options
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
      };
      
      if (request.body && request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
      }
      
      // Perform fetch (through extension or fallback)
      const response = await fetchFn(request.url, init);
      
      // Get response data
      const arrayBuffer = await response.arrayBuffer();
      const bodyBytes = new Uint8Array(arrayBuffer);
      
      // Get headers as JSON
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const headersJson = JSON.stringify(headers);
      const headersBytes = new TextEncoder().encode(headersJson);
      
      // Check if response fits in buffer
      const dataStart = DATA_START_INDEX * 4;
      const totalDataSize = bodyBytes.length + headersBytes.length;
      
      if (dataStart + totalDataSize > sharedBuffer.byteLength) {
        console.error("[SabHttp] Response too large for buffer:", totalDataSize);
        // Write error response
        Atomics.store(control, STATUS_INDEX, 500);
        Atomics.store(control, BODY_LENGTH_INDEX, 0);
        Atomics.store(control, HEADERS_LENGTH_INDEX, 0);
      } else {
        // Write response to SharedArrayBuffer
        Atomics.store(control, STATUS_INDEX, response.status);
        Atomics.store(control, BODY_LENGTH_INDEX, bodyBytes.length);
        Atomics.store(control, HEADERS_LENGTH_INDEX, headersBytes.length);
        
        // Copy body bytes
        dataView.set(bodyBytes, dataStart);
        
        // Copy headers bytes after body
        dataView.set(headersBytes, dataStart + bodyBytes.length);
      }
      
    } catch (e) {
      console.error("[SabHttp] Fetch failed:", e);
      
      // Write error response
      Atomics.store(control, STATUS_INDEX, 0);
      Atomics.store(control, BODY_LENGTH_INDEX, 0);
      Atomics.store(control, HEADERS_LENGTH_INDEX, 0);
    }
    
    // Signal worker to wake up
    Atomics.store(control, CONTROL_INDEX, 1);
    Atomics.notify(control, CONTROL_INDEX, 1);
  };
}

/**
 * Check if SharedArrayBuffer is available
 */
export function isSharedArrayBufferAvailable(): boolean {
  try {
    new SharedArrayBuffer(4);
    return true;
  } catch {
    return false;
  }
}
