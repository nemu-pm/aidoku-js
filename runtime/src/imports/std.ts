/**
 * std namespace - standard library functions (new aidoku-rs ABI)
 */
import type { GlobalStore } from "../global-store";
import { encodeVecString, decodeString, decodeI64, decodeBool, decodeF32 } from "../postcard";

// Object type enum matching Swift's WasmStd.ObjectType
const ObjectType = {
  Null: 0,
  Int: 1,
  Float: 2,
  String: 3,
  Bool: 4,
  Array: 5,
  Object: 6,
  Date: 7,
  Node: 8,
  Unknown: 9,
} as const;

// StdError codes matching aidoku-rs
const StdError = {
  InvalidDescriptor: -1,
  InvalidBufferSize: -2,
  FailedMemoryWrite: -3,
  InvalidString: -4,
  InvalidDateString: -5,
} as const;

// Check if value is a Cheerio node (duck typing)
function isCheerioNode(value: unknown): boolean {
  return value !== null && typeof value === "object" && "cheerio" in value;
}

export function createStdImports(store: GlobalStore) {
  return {
    // ============ NEW ABI (aidoku-rs) ============

    // Destroy a descriptor (free resources) - unified for all resource types
    destroy: (descriptor: number): void => {
      // aidoku-rs expects std.destroy to free any RID (requests, html, js, canvas, etc.)
      store.destroyResource(descriptor);
    },

    // Get the length of a buffer stored at a descriptor
    buffer_len: (descriptor: number): number => {
      if (descriptor < 0) return StdError.InvalidDescriptor;
      const value = store.readStdValue(descriptor);
      if (value === undefined) return StdError.InvalidDescriptor;

      if (value instanceof Uint8Array) {
        return value.length;
      }
      if (typeof value === "string") {
        // Raw UTF-8 for html.attr, html.text, etc (which call read_string_and_destroy)
        const encoded = new TextEncoder().encode(value);
        // Cache the encoded bytes for read_buffer
        store.updateStdValue(descriptor, encoded);
        return encoded.length;
      }
      // Handle string arrays by postcard-encoding them
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        const encoded = encodeVecString(value as string[]);
        // Cache the encoded bytes for read_buffer
        store.updateStdValue(descriptor, encoded);
        return encoded.length;
      }
      return StdError.InvalidDescriptor;
    },

    // Read buffer data into WASM memory
    read_buffer: (descriptor: number, bufferPtr: number, size: number): number => {
      if (descriptor < 0) return StdError.InvalidDescriptor;
      const value = store.readStdValue(descriptor);
      if (value === undefined) return StdError.InvalidDescriptor;

      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (typeof value === "string") {
        // Raw UTF-8 for html.attr, html.text, etc (which call read_string_and_destroy)
        bytes = new TextEncoder().encode(value);
      } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        // Handle string arrays by postcard-encoding them
        bytes = encodeVecString(value as string[]);
      } else {
        return StdError.InvalidDescriptor;
      }

      if (size > bytes.length) {
        return StdError.InvalidBufferSize;
      }

      try {
        store.writeBytes(bytes.slice(0, size), bufferPtr);
        return 0;
      } catch {
        return StdError.FailedMemoryWrite;
      }
    },

    // Get current date as Unix timestamp
    current_date: (): number => {
      return Date.now() / 1000;
    },

    // Get UTC offset in seconds
    utc_offset: (): bigint => {
      // Return the offset in seconds (negative because getTimezoneOffset returns minutes west of UTC)
      return BigInt(-new Date().getTimezoneOffset() * 60);
    },

    // Parse a date string into a Unix timestamp (f64 seconds since epoch)
    // aidoku-rs uses "UTC" and "current" as special timezone values
    parse_date: (
      stringPtr: number,
      stringLen: number,
      formatPtr: number,
      formatLen: number,
      _localePtr: number,
      _localeLen: number,
      timezonePtr: number,
      timezoneLen: number
    ): number => {
      if (stringLen <= 0) return StdError.InvalidDateString;
      if (formatLen <= 0) return StdError.InvalidDateString;

      const dateStr = store.readString(stringPtr, stringLen);
      const format = store.readString(formatPtr, formatLen);
      let tz = timezoneLen > 0 ? store.readString(timezonePtr, timezoneLen) : null;

      if (!dateStr || !format) return StdError.InvalidDateString;

      // Handle aidoku-rs special timezone values
      // "UTC" means parse as UTC
      // "current" means parse in local timezone
      if (tz === "current") {
        tz = null; // null = local timezone
      }

      const date = parseDateWithFormat(dateStr, format, tz);
      if (date) {
        return Math.floor(date.getTime() / 1000);
      }
      return StdError.InvalidDateString;
    },

    // ============ OLD ABI (legacy sources like aidoku-zh) ============

    // Copy a descriptor (increment ref count / duplicate value)
    copy: (descriptor: number): number => {
      if (descriptor < 0) return -1;
      const value = store.readStdValue(descriptor);
      if (value !== undefined) {
        return store.storeStdValue(value);
      }
      return -1;
    },

    // Get the type of a value at descriptor
    typeof: (descriptor: number): number => {
      if (descriptor < 0) return ObjectType.Null;
      const value = store.readStdValue(descriptor);

      if (value === null || value === undefined) {
        return ObjectType.Null;
      }
      if (typeof value === "number") {
        return Number.isInteger(value) ? ObjectType.Int : ObjectType.Float;
      }
      if (typeof value === "string") {
        return ObjectType.String;
      }
      if (typeof value === "boolean") {
        return ObjectType.Bool;
      }
      if (Array.isArray(value)) {
        return ObjectType.Array;
      }
      if (value instanceof Date) {
        return ObjectType.Date;
      }
      // Handle postcard-encoded Uint8Array from defaults.get (legacy ABI compatibility)
      // Try to detect the type by attempting to decode as string first
      if (value instanceof Uint8Array) {
        try {
          decodeString(value, 0);
          // Successfully decoded as string
          return ObjectType.String;
        } catch {
          // Not a string, could be int/float/bool/array
          // For now, treat as unknown since we can't easily determine the type
          return ObjectType.Unknown;
        }
      }
      // Check for Cheerio node
      if (isCheerioNode(value)) {
        return ObjectType.Node;
      }
      if (typeof value === "object") {
        return ObjectType.Object;
      }
      return ObjectType.Unknown;
    },

    // Create functions
    create_null: (): number => {
      return store.storeStdValue(null);
    },

    create_int: (value: bigint): number => {
      return store.storeStdValue(Number(value));
    },

    create_float: (value: number): number => {
      return store.storeStdValue(value);
    },

    create_string: (strPtr: number, strLen: number): number => {
      if (strLen <= 0) return -1;
      const str = store.readString(strPtr, strLen);
      if (str === null) return -1;
      return store.storeStdValue(str);
    },

    create_bool: (value: number): number => {
      return store.storeStdValue(value !== 0);
    },

    create_object: (): number => {
      return store.storeStdValue({});
    },

    create_array: (): number => {
      return store.storeStdValue([]);
    },

    create_date: (timestamp: number): number => {
      const date = timestamp < 0 ? new Date() : new Date(timestamp * 1000);
      return store.storeStdValue(date);
    },

    // String functions
    string_len: (descriptor: number): number => {
      if (descriptor < 0) return -1;
      const value = store.readStdValue(descriptor);
      if (typeof value === "string") {
        return new TextEncoder().encode(value).length;
      }
      // Handle postcard-encoded Uint8Array from defaults.get (legacy ABI compatibility)
      if (value instanceof Uint8Array) {
        try {
          const [str] = decodeString(value, 0);
          return new TextEncoder().encode(str).length;
        } catch {
          return -1;
        }
      }
      return -1;
    },

    read_string: (descriptor: number, buffer: number, size: number): void => {
      if (descriptor < 0 || size <= 0) return;
      const value = store.readStdValue(descriptor);
      if (typeof value === "string") {
        const bytes = new TextEncoder().encode(value);
        store.writeBytes(bytes.slice(0, size), buffer);
        return;
      }
      // Handle postcard-encoded Uint8Array from defaults.get (legacy ABI compatibility)
      if (value instanceof Uint8Array) {
        try {
          const [str] = decodeString(value, 0);
          const bytes = new TextEncoder().encode(str);
          store.writeBytes(bytes.slice(0, size), buffer);
        } catch {
          // Ignore decode errors
        }
      }
    },

    // Number reading functions
    read_int: (descriptor: number): bigint => {
      if (descriptor < 0) return BigInt(-1);
      const value = store.readStdValue(descriptor);
      if (typeof value === "number") {
        return BigInt(Math.floor(value));
      }
      if (typeof value === "boolean") {
        return BigInt(value ? 1 : 0);
      }
      if (typeof value === "string") {
        const num = parseInt(value, 10);
        return isNaN(num) ? BigInt(-1) : BigInt(num);
      }
      // Handle postcard-encoded Uint8Array from defaults.get (legacy ABI compatibility)
      // Try string first (most common case), then i64
      if (value instanceof Uint8Array) {
        try {
          // Try decoding as string first (e.g., "486922991" stored as postcard string)
          const [str] = decodeString(value, 0);
          const num = parseInt(str, 10);
          if (!isNaN(num)) return BigInt(num);
        } catch {
          // Not a string, try as i64
        }
        try {
          const [num] = decodeI64(value, 0);
          return BigInt(num);
        } catch {
          return BigInt(-1);
        }
      }
      return BigInt(-1);
    },

    read_float: (descriptor: number): number => {
      if (descriptor < 0) return -1;
      const value = store.readStdValue(descriptor);
      if (typeof value === "number") {
        return value;
      }
      if (typeof value === "string") {
        const num = parseFloat(value);
        return isNaN(num) ? -1 : num;
      }
      // Handle postcard-encoded Uint8Array from defaults.get (legacy ABI compatibility)
      if (value instanceof Uint8Array) {
        try {
          // Try decoding as string first (e.g., "123.45" stored as postcard string)
          const [str] = decodeString(value, 0);
          const num = parseFloat(str);
          if (!isNaN(num)) return num;
        } catch {
          // Not a string, try as f32
        }
        try {
          const [num] = decodeF32(value, 0);
          return num;
        } catch {
          return -1;
        }
      }
      return -1;
    },

    read_bool: (descriptor: number): number => {
      if (descriptor < 0) return 0;
      const value = store.readStdValue(descriptor);
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      if (typeof value === "number") {
        return value !== 0 ? 1 : 0;
      }
      // Handle postcard-encoded Uint8Array from defaults.get (legacy ABI compatibility)
      if (value instanceof Uint8Array) {
        try {
          const [bool] = decodeBool(value, 0);
          return bool ? 1 : 0;
        } catch {
          return 0;
        }
      }
      return 0;
    },

    read_date: (descriptor: number): number => {
      if (descriptor < 0) return -1;
      const value = store.readStdValue(descriptor);
      if (value instanceof Date) {
        return value.getTime() / 1000;
      }
      return -1;
    },

    read_date_string: (
      descriptor: number,
      formatPtr: number,
      formatLen: number,
      _localePtr: number,
      _localeLen: number,
      timezonePtr: number,
      timezoneLen: number
    ): number => {
      if (descriptor < 0 || formatLen <= 0) return -1;
      const value = store.readStdValue(descriptor);
      if (typeof value !== "string") return -1;

      const format = store.readString(formatPtr, formatLen);
      if (!format) return -1;

      const tz = timezoneLen > 0 ? store.readString(timezonePtr, timezoneLen) : null;

      const date = parseDateWithFormat(value, format, tz);
      if (date) {
        return Math.floor(date.getTime() / 1000);
      }
      return -1;
    },

    // Object functions
    object_len: (descriptor: number): number => {
      if (descriptor < 0) return 0;
      const value = store.readStdValue(descriptor);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value).length;
      }
      return 0;
    },

    object_get: (descriptor: number, keyPtr: number, keyLen: number): number => {
      if (descriptor < 0 || keyLen <= 0) return -1;
      const key = store.readString(keyPtr, keyLen);
      if (!key) return -1;

      const obj = store.readStdValue(descriptor);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const typedObj = obj as Record<string, unknown>;
        // Check property exists AND value is not undefined/null
        // (matches Swift behavior where nil properties return -1)
        if (key in typedObj && typedObj[key] !== undefined && typedObj[key] !== null) {
          return store.storeStdValue(typedObj[key]);
        }
      }
      return -1;
    },

    object_set: (
      descriptor: number,
      keyPtr: number,
      keyLen: number,
      valueDescriptor: number
    ): void => {
      if (descriptor < 0 || keyLen <= 0 || valueDescriptor < 0) return;
      const key = store.readString(keyPtr, keyLen);
      if (!key) return;

      const obj = store.readStdValue(descriptor);
      const value = store.readStdValue(valueDescriptor);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        (obj as Record<string, unknown>)[key] = value;
      }
    },

    object_remove: (descriptor: number, keyPtr: number, keyLen: number): void => {
      if (descriptor < 0 || keyLen <= 0) return;
      const key = store.readString(keyPtr, keyLen);
      if (!key) return;

      const obj = store.readStdValue(descriptor);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        delete (obj as Record<string, unknown>)[key];
      }
    },

    object_keys: (descriptor: number): number => {
      if (descriptor < 0) return -1;
      const obj = store.readStdValue(descriptor);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return store.storeStdValue(Object.keys(obj));
      }
      return -1;
    },

    object_values: (descriptor: number): number => {
      if (descriptor < 0) return -1;
      const obj = store.readStdValue(descriptor);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return store.storeStdValue(Object.values(obj));
      }
      return -1;
    },

    // Array functions
    array_len: (descriptor: number): number => {
      if (descriptor < 0) return 0;
      const value = store.readStdValue(descriptor);
      if (Array.isArray(value)) {
        return value.length;
      }
      return 0;
    },

    array_get: (descriptor: number, index: number): number => {
      if (descriptor < 0 || index < 0) return -1;
      const value = store.readStdValue(descriptor);
      if (Array.isArray(value) && index < value.length) {
        return store.storeStdValue(value[index]);
      }
      return -1;
    },

    array_set: (descriptor: number, index: number, valueDescriptor: number): void => {
      if (descriptor < 0 || index < 0 || valueDescriptor < 0) return;
      const arr = store.readStdValue(descriptor);
      const value = store.readStdValue(valueDescriptor);
      if (Array.isArray(arr) && index < arr.length) {
        arr[index] = value;
      }
    },

    array_append: (descriptor: number, valueDescriptor: number): void => {
      if (descriptor < 0 || valueDescriptor < 0) return;
      const arr = store.readStdValue(descriptor);
      const value = store.readStdValue(valueDescriptor);
      if (Array.isArray(arr)) {
        arr.push(value);
      }
    },

    array_remove: (descriptor: number, index: number): void => {
      if (descriptor < 0 || index < 0) return;
      const arr = store.readStdValue(descriptor);
      if (Array.isArray(arr) && index < arr.length) {
        arr.splice(index, 1);
      }
    },
  };
}

// ============================================================================
// Date Parsing Helpers
// ============================================================================

// Swift/iOS DateFormatter format mappings to standard formats
const FORMAT_MAPPINGS: Record<string, string> = {
  yyyy: "YYYY",
  yy: "YY",
  MMMM: "MMMM",
  MMM: "MMM",
  MM: "MM",
  M: "M",
  dd: "DD",
  d: "D",
  HH: "HH",
  H: "H",
  hh: "hh",
  h: "h",
  mm: "mm",
  m: "m",
  ss: "ss",
  s: "s",
  a: "A",
  Z: "Z",
  z: "z",
  ZZZZZ: "Z",
  ZZZ: "ZZ",
};

// Convert Swift format to standard format
function convertFormat(swiftFormat: string): string {
  let result = swiftFormat;
  const sortedKeys = Object.keys(FORMAT_MAPPINGS).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    result = result.replace(new RegExp(key, "g"), FORMAT_MAPPINGS[key]);
  }
  return result;
}

// Common relative date patterns in multiple languages
const RELATIVE_PATTERNS = [
  // English
  { pattern: /(\d+)\s*seconds?\s*ago/i, unit: "second" as const },
  { pattern: /(\d+)\s*minutes?\s*ago/i, unit: "minute" as const },
  { pattern: /(\d+)\s*hours?\s*ago/i, unit: "hour" as const },
  { pattern: /(\d+)\s*days?\s*ago/i, unit: "day" as const },
  { pattern: /(\d+)\s*weeks?\s*ago/i, unit: "week" as const },
  { pattern: /(\d+)\s*months?\s*ago/i, unit: "month" as const },
  { pattern: /(\d+)\s*years?\s*ago/i, unit: "year" as const },
  { pattern: /just\s*now/i, unit: "now" as const },
  { pattern: /today/i, unit: "today" as const },
  { pattern: /yesterday/i, unit: "yesterday" as const },
  // Chinese
  { pattern: /(\d+)\s*秒前/i, unit: "second" as const },
  { pattern: /(\d+)\s*分钟前/i, unit: "minute" as const },
  { pattern: /(\d+)\s*小时前/i, unit: "hour" as const },
  { pattern: /(\d+)\s*天前/i, unit: "day" as const },
  { pattern: /(\d+)\s*周前/i, unit: "week" as const },
  { pattern: /(\d+)\s*个?月前/i, unit: "month" as const },
  { pattern: /(\d+)\s*年前/i, unit: "year" as const },
  { pattern: /刚刚/i, unit: "now" as const },
  { pattern: /今天/i, unit: "today" as const },
  { pattern: /昨天/i, unit: "yesterday" as const },
  // Japanese
  { pattern: /(\d+)\s*分前/i, unit: "minute" as const },
  { pattern: /(\d+)\s*時間前/i, unit: "hour" as const },
  { pattern: /(\d+)\s*日前/i, unit: "day" as const },
  { pattern: /(\d+)\s*週間前/i, unit: "week" as const },
  { pattern: /(\d+)\s*ヶ?月前/i, unit: "month" as const },
  // Korean
  { pattern: /(\d+)\s*초\s*전/i, unit: "second" as const },
  { pattern: /(\d+)\s*분\s*전/i, unit: "minute" as const },
  { pattern: /(\d+)\s*시간\s*전/i, unit: "hour" as const },
  { pattern: /(\d+)\s*일\s*전/i, unit: "day" as const },
  { pattern: /(\d+)\s*주\s*전/i, unit: "week" as const },
  { pattern: /(\d+)\s*개?월\s*전/i, unit: "month" as const },
  { pattern: /(\d+)\s*년\s*전/i, unit: "year" as const },
];

// Parse relative dates
function parseRelativeDate(str: string): Date | null {
  const now = new Date();

  for (const { pattern, unit } of RELATIVE_PATTERNS) {
    const match = str.match(pattern);
    if (match) {
      if (unit === "now") {
        return now;
      }
      if (unit === "today") {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }
      if (unit === "yesterday") {
        const d = new Date(now);
        d.setDate(d.getDate() - 1);
        d.setHours(0, 0, 0, 0);
        return d;
      }

      const amount = parseInt(match[1], 10);
      if (!isNaN(amount)) {
        const result = new Date(now);
        switch (unit) {
          case "second":
            result.setSeconds(result.getSeconds() - amount);
            break;
          case "minute":
            result.setMinutes(result.getMinutes() - amount);
            break;
          case "hour":
            result.setHours(result.getHours() - amount);
            break;
          case "day":
            result.setDate(result.getDate() - amount);
            break;
          case "week":
            result.setDate(result.getDate() - amount * 7);
            break;
          case "month":
            result.setMonth(result.getMonth() - amount);
            break;
          case "year":
            result.setFullYear(result.getFullYear() - amount);
            break;
        }
        return result;
      }
    }
  }
  return null;
}

// Date parsing helper - handles common Swift DateFormatter formats
function parseDateWithFormat(str: string, format: string, tz: string | null): Date | null {
  try {
    // Trim the string
    str = str.trim();

    // Try relative date parsing first
    const relativeDate = parseRelativeDate(str);
    if (relativeDate) {
      return relativeDate;
    }

    // Convert Swift format to standard format
    const _convertedFormat = convertFormat(format);

    // Try native parsing
    const parsed = new Date(str);

    if (!isNaN(parsed.getTime())) {
      // Apply timezone offset if UTC specified
      if (tz === "UTC") {
        // The parsed date is already in local time, adjust to UTC
        const utcMs = parsed.getTime() + parsed.getTimezoneOffset() * 60000;
        return new Date(utcMs);
      }
      return parsed;
    }

    // Fallback: try various common formats
    const commonFormats = [
      /(\d{4})-(\d{2})-(\d{2})/,
      /(\d{4})\/(\d{2})\/(\d{2})/,
      /(\d{2})-(\d{2})-(\d{4})/,
      /(\d{2})\/(\d{2})\/(\d{4})/,
    ];

    for (const regex of commonFormats) {
      const match = str.match(regex);
      if (match) {
        // Try to construct date from matched groups
        const date = new Date(str);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export { parseDateWithFormat, parseRelativeDate, convertFormat };

