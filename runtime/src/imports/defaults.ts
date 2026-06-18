/**
 * defaults namespace - User settings storage
 * Settings are provided via a SettingsGetter callback
 */
import type { GlobalStore } from "../global-store";
import {
  encodeString,
  encodeI32,
  encodeF32,
  encodeBool,
  encodeVecString,
  decodeString,
  decodeI64,
  decodeF32,
  decodeBool,
  decodeVec,
} from "../postcard";

/** Function to get a setting value */
export type SettingsGetter = (key: string) => unknown;

/** Function to set a setting value (for persistence) */
export type SettingsSetter = (key: string, value: unknown) => void;

// DefaultValue kind enum matching aidoku-rs
const DefaultKind = {
  Data: 0, // Raw bytes (postcard-encoded)
  Bool: 1,
  Int: 2, // i32
  Float: 3, // f32
  String: 4,
  StringArray: 5,
  Null: 6,
} as const;

export function createDefaultsImports(
  store: GlobalStore,
  settingsGetter: SettingsGetter,
  settingsSetter?: SettingsSetter
) {
  // Read the framed FFI payload written by the WASM side.
  // Layout: [i32 length][8-byte metadata][payload]. We skip the 8-byte header
  // and return the remaining `length - 8` bytes so postcard decoders can work
  // against the actual payload length (not an over-read 4KB window).
  function readItemBytes(ptr: number): Uint8Array | null {
    if (ptr <= 0) return null;
    const memory = store.memory;
    if (!memory) return null;
    try {
      const view = new DataView(memory.buffer);
      const len = view.getInt32(ptr, true);
      if (len <= 8) return null;
      return new Uint8Array(memory.buffer, ptr + 8, len - 8).slice();
    } catch {
      return null;
    }
  }

  // Helper to encode a JS value to postcard bytes for storage
  function encodeValueForStorage(value: unknown): Uint8Array {
    if (value === null || value === undefined) {
      return new Uint8Array([0]); // empty
    }
    if (typeof value === "boolean") {
      return encodeBool(value);
    }
    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        return encodeI32(value);
      }
      return encodeF32(value);
    }
    if (typeof value === "string") {
      return encodeString(value);
    }
    if (Array.isArray(value)) {
      return encodeVecString(value.map(String));
    }
    // For objects/other types, try JSON as string
    return encodeString(JSON.stringify(value));
  }

  // Helper to decode postcard bytes from WASM memory based on kind
  function decodeValueFromWasm(kind: number, ptr: number): unknown {
    if (kind === DefaultKind.Null) return null;

    const bytes = readItemBytes(ptr);
    if (!bytes) return null;

    try {
      switch (kind) {
        case DefaultKind.Bool: {
          const [val] = decodeBool(bytes, 0);
          return val;
        }
        case DefaultKind.Int: {
          // i32 is zigzag varint encoded in postcard
          const [val] = decodeI64(bytes, 0); // Use i64 decoder which handles zigzag
          return val;
        }
        case DefaultKind.Float: {
          const [val] = decodeF32(bytes, 0);
          return val;
        }
        case DefaultKind.String: {
          const [val] = decodeString(bytes, 0);
          return val;
        }
        case DefaultKind.StringArray: {
          const [val] = decodeVec(bytes, 0, decodeString);
          return val;
        }
        case DefaultKind.Data:
          // The FFI payload is already the raw data bytes - no re-decoding
          // of a length varint is needed (that was a double-decode bug).
          return bytes;
        default:
          return null;
      }
    } catch (e) {
      console.error("[defaults] Failed to decode value:", e);
      return null;
    }
  }

  return {
    // Signature: get(key: *const u8, len: usize) -> FFIResult (RID to value)
    // aidoku-rs: Calls read::<T>() which uses postcard::from_bytes(), so we store postcard-encoded bytes
    get: (keyPtr: number, keyLen: number): number => {
      if (keyLen <= 0) return -1;
      const key = store.readString(keyPtr, keyLen);
      if (!key) return -1;

      // Read from settings getter
      const value = settingsGetter(key);
      if (value !== undefined && value !== null) {
        // aidoku-rs calls read::<T>() which uses postcard::from_bytes() to deserialize
        // So we store postcard-encoded bytes directly
        const encoded = encodeValueForStorage(value);
        return store.storeStdValue(encoded);
      }
      // Setting not configured - this is normal, sources have optional settings
      return -1;
    },

    // aidoku-rs signature: set(key: *const u8, len: usize, kind: u8, value: Ptr) -> FFIResult
    set: (keyPtr: number, keyLen: number, kind: number, valuePtr: number): number => {
      if (keyLen <= 0) return -4; // InvalidString
      const key = store.readString(keyPtr, keyLen);
      if (!key) return -4;

      // Decode value from WASM memory based on kind
      const value = decodeValueFromWasm(kind, valuePtr);

      // Call setter if provided
      if (settingsSetter) {
        settingsSetter(key, value);
      }

      return 0; // Success
    },
  };
}

