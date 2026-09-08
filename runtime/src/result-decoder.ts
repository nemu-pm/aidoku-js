/**
 * Shared helpers for decoding WASM result pointers (aidoku-rs ABI)
 *
 * Result format from aidoku-rs __handle_result:
 * [len: i32 LE][cap: i32 LE][postcard payload...]
 *
 * The payload is postcard-encoded and may contain:
 * - Primitive values (i32 as zigzag varint, bool, etc.)
 * - Structs (serialized fields in order)
 * - Rids (i32 references to store resources)
 */

/**
 * Read the raw postcard payload from a WASM result pointer.
 * Returns null if the pointer is invalid or the result is empty.
 */
export function readResultPayload(
  memory: WebAssembly.Memory,
  ptr: number
): Uint8Array | null {
  if (ptr <= 0) {
    return null;
  }

  try {
    const view = new DataView(memory.buffer);
    const len = view.getInt32(ptr, true);

    if (len <= 8) {
      return null;
    }

    // Data starts after the 8-byte header (len + capacity)
    const payloadLen = len - 8;
    const data = new Uint8Array(memory.buffer, ptr + 8, payloadLen);
    return data.slice(); // Copy to avoid issues with memory changes
  } catch {
    return null;
  }
}

/**
 * Decode a zigzag-encoded varint from bytes.
 * Returns [decodedValue, bytesRead].
 */
export function decodeZigzagVarint(
  bytes: Uint8Array,
  offset = 0
): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;

  while (pos < bytes.length) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  // Decode zigzag: (n >>> 1) ^ -(n & 1)
  const decoded = (result >>> 1) ^ -(result & 1);
  return [decoded, pos - offset];
}

/**
 * Decode an i32 RID from a WASM result payload.
 * Used for get_image_request, process_page_image and process_cover_image results.
 */
export function decodeRidFromPayload(payload: Uint8Array): number | null {
  if (!payload || payload.length === 0) {
    return null;
  }

  try {
    const [rid] = decodeZigzagVarint(payload, 0);
    return rid;
  } catch {
    return null;
  }
}

/**
 * Error result codes returned by a source.
 *
 * A source function that fails returns one of these negative codes instead of
 * a result pointer. `Message` is special: the source allocates a buffer whose
 * first `i32` is -1 and appends the message text after the header, so the
 * value seen by the host is a positive pointer with a -1 marker.
 */
export const AidokuResultErrorCode = {
  /** The source passed a message string back to the app. */
  Message: -1,
  /** The called function is not implemented by the source. */
  Unimplemented: -2,
  /** An HTTP request failed. */
  RequestError: -3,
  /** An HTML parsing or selector operation failed. */
  HtmlError: -4,
  /** A JavaScript evaluation failed. */
  JsError: -5,
  /** A canvas or image operation failed. */
  CanvasError: -6,
  /** Response bytes were not valid UTF-8. */
  Utf8Error: -7,
  /** JSON parsing failed. */
  JsonParseError: -8,
  /** Postcard deserialization failed. */
  DeserializeError: -9,
} as const;
export type AidokuResultErrorCode =
  (typeof AidokuResultErrorCode)[keyof typeof AidokuResultErrorCode];

const RESULT_ERROR_MESSAGES: Record<number, string> = {
  [AidokuResultErrorCode.Message]: "Source error",
  [AidokuResultErrorCode.Unimplemented]: "Unimplemented",
  [AidokuResultErrorCode.RequestError]: "Request error",
  [AidokuResultErrorCode.HtmlError]: "HTML parse error",
  [AidokuResultErrorCode.JsError]: "JavaScript error",
  [AidokuResultErrorCode.CanvasError]: "Canvas error",
  [AidokuResultErrorCode.Utf8Error]: "UTF-8 decode error",
  [AidokuResultErrorCode.JsonParseError]: "JSON parse error",
  [AidokuResultErrorCode.DeserializeError]: "Deserialize error",
};

/**
 * Check if a result pointer indicates an error.
 * See {@link AidokuResultErrorCode} for the codes a source can return.
 */
export function isResultError(ptr: number): boolean {
  return ptr < 0;
}

/**
 * Get error message from error result pointer.
 * Returns null for successful (non-negative) results.
 */
export function getResultErrorMessage(
  _memory: WebAssembly.Memory,
  ptr: number
): string | null {
  if (ptr >= 0) {
    return null;
  }

  return RESULT_ERROR_MESSAGES[ptr] ?? `Error code: ${ptr}`;
}

/**
 * An error raised for a negative result code returned by a source.
 * `code` is one of {@link AidokuResultErrorCode}, so callers can tell an
 * unimplemented function apart from a failed request without matching strings.
 */
export class AidokuResultError extends Error {
  readonly code: number;

  constructor(code: number, message?: string) {
    super(message ?? RESULT_ERROR_MESSAGES[code] ?? `Error code: ${code}`);
    this.name = "AidokuResultError";
    this.code = code;
  }
}

/** Build an {@link AidokuResultError} from a negative result pointer. */
export function createResultError(
  memory: WebAssembly.Memory,
  ptr: number
): AidokuResultError {
  return new AidokuResultError(ptr, getResultErrorMessage(memory, ptr) ?? undefined);
}

/**
 * Layout of a Message error buffer:
 * [marker: i32 -1][cap: i32][total_len: i32][utf8 message...]
 *
 * The marker sits where a successful result stores its length, so a positive
 * pointer whose first i32 is -1 carries an error message, not a payload.
 */
const MESSAGE_ERROR_MARKER = -1;
const MESSAGE_ERROR_HEADER_BYTES = 12;

/**
 * Read the text of a Message error buffer.
 * Returns null when the pointer does not hold one.
 */
export function readResultErrorMessage(
  memory: WebAssembly.Memory,
  ptr: number
): string | null {
  if (ptr <= 0) {
    return null;
  }

  try {
    const view = new DataView(memory.buffer);
    if (view.getInt32(ptr, true) !== MESSAGE_ERROR_MARKER) {
      return null;
    }

    const totalLen = view.getInt32(ptr + 8, true);
    if (totalLen <= MESSAGE_ERROR_HEADER_BYTES) {
      return "";
    }

    const bytes = new Uint8Array(
      memory.buffer,
      ptr + MESSAGE_ERROR_HEADER_BYTES,
      totalLen - MESSAGE_ERROR_HEADER_BYTES
    );
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Read a result payload, raising {@link AidokuResultError} for error results.
 *
 * Handles both error shapes: a negative code, and a positive pointer to a
 * Message buffer, whose text becomes the error message. The error buffer is
 * released through `freeResult` when one is available, since the caller's own
 * cleanup is skipped once this throws.
 */
export function readResultOrThrow(
  memory: WebAssembly.Memory,
  ptr: number,
  freeResult?: (ptr: number) => void
): Uint8Array | null {
  if (ptr < 0) {
    throw createResultError(memory, ptr);
  }

  const message = readResultErrorMessage(memory, ptr);
  if (message !== null) {
    // Keep the generic fallback only for an empty message.
    const error = new AidokuResultError(
      AidokuResultErrorCode.Message,
      message || undefined
    );
    freeResult?.(ptr);
    throw error;
  }

  return readResultPayload(memory, ptr);
}

/** Runtime mode for ABI detection */
export const RuntimeMode = {
  /** Legacy Swift-era ABI with descriptors and object model */
  Legacy: "legacy",
  /** Modern aidoku-rs ABI with postcard encoding */
  AidokuRs: "aidoku-rs",
} as const;
export type RuntimeMode = (typeof RuntimeMode)[keyof typeof RuntimeMode];

/** Detect runtime mode based on available WASM exports. */
export function detectRuntimeMode(
  exports: Record<string, WebAssembly.ExportValue>
): RuntimeMode {
  // NEW ABI (aidoku-rs): get_search_manga_list, get_manga_update, get_page_list (2 args)
  // OLD ABI (legacy): get_manga_list, get_manga_details, get_chapter_list

  const hasNewAbiExports =
    "get_search_manga_list" in exports || "get_manga_update" in exports;

  const hasLegacyExports =
    "get_manga_details" in exports || "get_chapter_list" in exports;

  // If we have new ABI exports, use aidoku-rs mode
  // (even if legacy exports also exist, prefer new ABI)
  if (hasNewAbiExports) {
    return RuntimeMode.AidokuRs;
  }

  // Fallback to legacy mode
  if (hasLegacyExports) {
    return RuntimeMode.Legacy;
  }

  // Default to aidoku-rs for unknown exports
  return RuntimeMode.AidokuRs;
}

