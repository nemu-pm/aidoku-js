/**
 * Postcard serialization/deserialization for Aidoku WASM communication.
 * Uses @variegated-coffee/serde-postcard-ts for core primitives.
 */
import {
  tryEncodeString,
  tryEncodeVarintI64,
  tryDecodeString,
  tryDecodeVarintU32,
  tryDecodeVarintI64,
  tryDecodeF32,
  tryDecodeU8,
} from "@variegated-coffee/serde-postcard-ts";
import {
  FilterType,
  type Manga,
  type Chapter,
  type FilterValue,
  type Listing,
  type HomeLayout,
  type HomeComponent,
  type HomeComponentValue,
  type HomeLink,
  type HomeLinkValue,
  type HomeFilterItem,
  type MangaWithChapter,
  type MangaStatus,
  type ContentRating,
} from "./types";

export { tryEncodeString, tryDecodeString };

// ============================================================================
// Primitive Decoders
// ============================================================================

/** Encode a string for postcard format */
export function encodeString(str: string): Uint8Array {
  const result = tryEncodeString(str);
  if (!result.ok) {
    throw new Error(`Failed to encode string: ${result.error}`);
  }
  return result.value.bytes;
}

/** Decode a string from postcard format */
export function decodeString(bytes: Uint8Array, offset = 0): [string, number] {
  const result = tryDecodeString(bytes, offset);
  if (!result.ok) {
    throw new Error(`Failed to decode string at offset ${offset}: ${result.error}`);
  }
  return [result.value.value, result.value.bytesRead + offset];
}

/** Encode empty Vec (just length 0) */
export function encodeEmptyVec(): Uint8Array {
  return new Uint8Array([0]);
}

/** Encode Option<String> - None = 0, Some = 1 + string */
export function encodeOptionString(str: string | null): Uint8Array {
  if (str === null) {
    return new Uint8Array([0]); // None
  }
  const strBytes = encodeString(str);
  const result = new Uint8Array(1 + strBytes.length);
  result[0] = 1; // Some
  result.set(strBytes, 1);
  return result;
}

/** Decode Option<String> */
export function decodeOptionString(bytes: Uint8Array, offset = 0): [string | null, number] {
  if (bytes[offset] === 0) {
    return [null, offset + 1];
  }
  return decodeString(bytes, offset + 1);
}

/** Decode varint u32 */
export function decodeVarint(bytes: Uint8Array, offset = 0): [number, number] {
  const result = tryDecodeVarintU32(bytes, offset);
  if (!result.ok) {
    throw new Error(`Failed to decode varint: ${result.error}`);
  }
  return [result.value.value, result.value.bytesRead + offset];
}

/** Decode i32 (little-endian fixed size) */
export function decodeI32(bytes: Uint8Array, offset: number): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return [view.getInt32(0, true), offset + 4];
}

/** Decode i64 (zigzag varint, as number - may lose precision for very large values) */
export function decodeI64(bytes: Uint8Array, offset: number): [number, number] {
  const result = tryDecodeVarintI64(bytes, offset);
  if (!result.ok) {
    throw new Error(`Failed to decode i64: ${result.error}`);
  }
  return [Number(result.value.value), result.value.bytesRead + offset];
}

/** Decode f32 */
export function decodeF32(bytes: Uint8Array, offset: number): [number, number] {
  const result = tryDecodeF32(bytes, offset);
  if (!result.ok) {
    throw new Error(`Failed to decode f32: ${result.error}`);
  }
  return [result.value.value, result.value.bytesRead + offset];
}

/** Decode u8 */
export function decodeU8(bytes: Uint8Array, offset: number): [number, number] {
  const result = tryDecodeU8(bytes, offset);
  if (!result.ok) {
    throw new Error(`Failed to decode u8: ${result.error}`);
  }
  return [result.value.value, result.value.bytesRead + offset];
}

/** Decode bool */
export function decodeBool(bytes: Uint8Array, offset: number): [boolean, number] {
  return [bytes[offset] !== 0, offset + 1];
}

/** Decode Option<T> */
export function decodeOption<T>(
  bytes: Uint8Array,
  offset: number,
  decodeInner: (bytes: Uint8Array, offset: number) => [T, number]
): [T | null, number] {
  if (bytes[offset] === 0) {
    return [null, offset + 1];
  }
  return decodeInner(bytes, offset + 1);
}

/** Decode Vec<T> */
export function decodeVec<T>(
  bytes: Uint8Array,
  offset: number,
  decodeItem: (bytes: Uint8Array, offset: number) => [T, number]
): [T[], number] {
  const [len, lenEnd] = decodeVarint(bytes, offset);
  const items: T[] = [];
  let pos = lenEnd;

  for (let i = 0; i < len; i++) {
    const [item, itemEnd] = decodeItem(bytes, pos);
    items.push(item);
    pos = itemEnd;
  }

  return [items, pos];
}

// ============================================================================
// Chapter/Manga Decoders
// ============================================================================

export interface DecodedChapter {
  key: string;
  title: string | null;
  chapterNumber: number | null;
  volumeNumber: number | null;
  dateUploaded: number | null;
  scanlators: string[] | null;
  url: string | null;
  language: string | null;
  thumbnail: string | null;
  locked: boolean;
}

export function decodeChapter(bytes: Uint8Array, offset: number): [DecodedChapter, number] {
  let pos = offset;

  let key: string;
  let title: string | null;
  let chapterNumber: number | null;
  let volumeNumber: number | null;
  let dateUploaded: number | null;
  let scanlators: string[] | null;
  let url: string | null;
  let language: string | null;
  let thumbnail: string | null;
  let locked: boolean;

  [key, pos] = decodeString(bytes, pos);
  [title, pos] = decodeOption(bytes, pos, decodeString);
  [chapterNumber, pos] = decodeOption(bytes, pos, decodeF32);
  [volumeNumber, pos] = decodeOption(bytes, pos, decodeF32);
  [dateUploaded, pos] = decodeOption(bytes, pos, decodeI64);
  [scanlators, pos] = decodeOption(bytes, pos, (b, o) => decodeVec(b, o, decodeString));
  [url, pos] = decodeOption(bytes, pos, decodeString);
  [language, pos] = decodeOption(bytes, pos, decodeString);
  [thumbnail, pos] = decodeOption(bytes, pos, decodeString);
  [locked, pos] = decodeBool(bytes, pos);

  return [
    {
      key,
      title,
      chapterNumber,
      volumeNumber,
      dateUploaded,
      scanlators,
      url,
      language,
      thumbnail,
      locked,
    },
    pos,
  ];
}

export interface DecodedManga {
  key: string;
  title: string;
  cover: string | null;
  artists: string[] | null;
  authors: string[] | null;
  description: string | null;
  url: string | null;
  tags: string[] | null;
  status: number;
  contentRating: number;
  viewer: number;
  updateStrategy: number;
  nextUpdateTime: number | null;
  chapters: DecodedChapter[] | null;
}

export function decodeManga(bytes: Uint8Array, offset: number): [DecodedManga, number] {
  let pos = offset;

  let key: string;
  let title: string;
  let cover: string | null;
  let artists: string[] | null;
  let authors: string[] | null;
  let description: string | null;
  let url: string | null;
  let tags: string[] | null;
  let status: number;
  let contentRating: number;
  let viewer: number;
  let updateStrategy: number;
  let nextUpdateTime: number | null;

  [key, pos] = decodeString(bytes, pos);
  [title, pos] = decodeString(bytes, pos);
  [cover, pos] = decodeOption(bytes, pos, decodeString);
  [artists, pos] = decodeOption(bytes, pos, (b, o) => decodeVec(b, o, decodeString));
  [authors, pos] = decodeOption(bytes, pos, (b, o) => decodeVec(b, o, decodeString));
  [description, pos] = decodeOption(bytes, pos, decodeString);
  [url, pos] = decodeOption(bytes, pos, decodeString);
  [tags, pos] = decodeOption(bytes, pos, (b, o) => decodeVec(b, o, decodeString));

  [status, pos] = decodeU8(bytes, pos);
  [contentRating, pos] = decodeU8(bytes, pos);
  [viewer, pos] = decodeU8(bytes, pos);
  [updateStrategy, pos] = decodeU8(bytes, pos);
  [nextUpdateTime, pos] = decodeOption(bytes, pos, decodeI64);

  let chapters: DecodedChapter[] | null;
  [chapters, pos] = decodeOption(bytes, pos, (b, o) => decodeVec(b, o, decodeChapter));

  return [
    {
      key,
      title,
      cover,
      artists,
      authors,
      description,
      url,
      tags,
      status,
      contentRating,
      viewer,
      updateStrategy,
      nextUpdateTime,
      chapters,
    },
    pos,
  ];
}

export interface DecodedMangaPageResult {
  entries: DecodedManga[];
  hasNextPage: boolean;
}

export function decodeMangaPageResult(bytes: Uint8Array, offset = 0): DecodedMangaPageResult {
  let pos = offset;

  const [entries, entriesEnd] = decodeVec(bytes, pos, decodeManga);
  pos = entriesEnd;

  const [hasNextPage] = decodeBool(bytes, pos);

  return { entries, hasNextPage };
}

// ============================================================================
// Page Decoder
// ============================================================================

export interface DecodedPage {
  url: string | null;
  text: string | null;
  context: Record<string, string> | null;
  thumbnail: string | null;
  hasDescription: boolean;
  description: string | null;
}

export function decodePage(bytes: Uint8Array, offset: number): [DecodedPage, number] {
  let pos = offset;

  let url: string | null = null;
  let text: string | null = null;
  let context: Record<string, string> | null = null;

  const [variant, variantEnd] = decodeVarint(bytes, pos);
  pos = variantEnd;

  if (variant === 0) {
    // Url(String, Option<PageContext>)
    [url, pos] = decodeString(bytes, pos);

    const hasContext = bytes[pos++];
    if (hasContext === 1) {
      context = {};
      const [mapLen, mapLenEnd] = decodeVarint(bytes, pos);
      pos = mapLenEnd;
      for (let i = 0; i < mapLen; i++) {
        let key: string, value: string;
        [key, pos] = decodeString(bytes, pos);
        [value, pos] = decodeString(bytes, pos);
        context[key] = value;
      }
    }
  } else if (variant === 1) {
    // Text(String)
    [text, pos] = decodeString(bytes, pos);
  } else if (variant === 2) {
    // Zip(String, String)
    let zipUrl: string, filePath: string;
    [zipUrl, pos] = decodeString(bytes, pos);
    [filePath, pos] = decodeString(bytes, pos);
    url = `${zipUrl}#${filePath}`;
  }

  let thumbnail: string | null;
  [thumbnail, pos] = decodeOption(bytes, pos, decodeString);

  let hasDescription: boolean;
  [hasDescription, pos] = decodeBool(bytes, pos);

  let description: string | null;
  [description, pos] = decodeOption(bytes, pos, decodeString);

  return [{ url, text, context, thumbnail, hasDescription, description }, pos];
}

export function decodePageList(bytes: Uint8Array, offset = 0): DecodedPage[] {
  const [pages] = decodeVec(bytes, offset, decodePage);
  return pages;
}

// ============================================================================
// Filter Decoders
// ============================================================================

export interface DecodedSortSelection {
  index: number;
  ascending: boolean;
}

export interface DecodedGenreSelection {
  index: number;
  state: number;
}

export interface DecodedFilter {
  type: number;
  name: string;
  options?: string[];
  default?: number | boolean | DecodedSortSelection | DecodedGenreSelection[];
  canAscend?: boolean;
  canExclude?: boolean;
  filters?: DecodedFilter[];
}

function decodeSortSelection(bytes: Uint8Array, offset: number): [DecodedSortSelection, number] {
  let pos = offset;
  let index: number;
  let ascending: boolean;

  [index, pos] = decodeVarint(bytes, pos);
  [ascending, pos] = decodeBool(bytes, pos);

  return [{ index, ascending }, pos];
}

function decodeGenreSelection(bytes: Uint8Array, offset: number): [DecodedGenreSelection, number] {
  let pos = offset;
  let index: number;
  let state: number;

  [index, pos] = decodeVarint(bytes, pos);
  const [stateRaw, stateEnd] = decodeVarint(bytes, pos);
  state = (stateRaw >>> 1) ^ -(stateRaw & 1);
  pos = stateEnd;

  return [{ index, state }, pos];
}

export function decodeFilter(bytes: Uint8Array, offset: number): [DecodedFilter, number] {
  let pos = offset;

  const [variant, variantEnd] = decodeVarint(bytes, pos);
  pos = variantEnd;

  let name: string;

  switch (variant) {
    case 0: // Title
      [name, pos] = decodeString(bytes, pos);
      return [{ type: 0, name }, pos];

    case 1: // Author
      [name, pos] = decodeString(bytes, pos);
      return [{ type: 1, name }, pos];

    case 2: {
      // Select
      [name, pos] = decodeString(bytes, pos);
      let options: string[];
      [options, pos] = decodeVec(bytes, pos, decodeString);
      let defaultVal: number;
      [defaultVal, pos] = decodeVarint(bytes, pos);
      return [{ type: 2, name, options, default: defaultVal }, pos];
    }

    case 3: {
      // Sort
      [name, pos] = decodeString(bytes, pos);
      let options: string[];
      [options, pos] = decodeVec(bytes, pos, decodeString);
      let defaultVal: DecodedSortSelection;
      [defaultVal, pos] = decodeSortSelection(bytes, pos);
      let canAscend: boolean;
      [canAscend, pos] = decodeBool(bytes, pos);
      return [{ type: 3, name, options, default: defaultVal, canAscend }, pos];
    }

    case 4: {
      // Check
      [name, pos] = decodeString(bytes, pos);
      let defaultVal: boolean;
      [defaultVal, pos] = decodeBool(bytes, pos);
      return [{ type: 4, name, default: defaultVal }, pos];
    }

    case 5: {
      // Group
      [name, pos] = decodeString(bytes, pos);
      let filters: DecodedFilter[];
      [filters, pos] = decodeVec(bytes, pos, decodeFilter);
      return [{ type: 5, name, filters }, pos];
    }

    case 6: {
      // Genre
      [name, pos] = decodeString(bytes, pos);
      let options: string[];
      [options, pos] = decodeVec(bytes, pos, decodeString);
      let canExclude: boolean;
      [canExclude, pos] = decodeBool(bytes, pos);
      let defaultVal: DecodedGenreSelection[];
      [defaultVal, pos] = decodeVec(bytes, pos, decodeGenreSelection);
      return [{ type: 6, name, options, canExclude, default: defaultVal }, pos];
    }

    default:
      throw new Error(`Unknown filter variant: ${variant}`);
  }
}

export function decodeFilterList(bytes: Uint8Array, offset = 0): DecodedFilter[] {
  const [filters] = decodeVec(bytes, offset, decodeFilter);
  return filters;
}

// ============================================================================
// Encoding Helpers
// ============================================================================

export function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function encodeVarint(val: number): Uint8Array {
  const bytes: number[] = [];
  while (val >= 0x80) {
    bytes.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  bytes.push(val);
  return new Uint8Array(bytes);
}

export function encodeVecString(arr: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(arr.length));
  for (const s of arr) {
    parts.push(encodeString(s));
  }
  return concatBytes(parts);
}

export function encodeBool(val: boolean): Uint8Array {
  return new Uint8Array([val ? 1 : 0]);
}

export function encodeI32(val: number): Uint8Array {
  const zigzag = (val << 1) ^ (val >> 31);
  return encodeVarint(zigzag >>> 0);
}

export function encodeF32(val: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setFloat32(0, val, true);
  return new Uint8Array(buf);
}

export function encodeOptionBytes(str: string | null): Uint8Array {
  if (str === null) return new Uint8Array([0]);
  const strBytes = encodeString(str);
  const result = new Uint8Array(1 + strBytes.length);
  result[0] = 1;
  result.set(strBytes, 1);
  return result;
}

export function encodeOptionVecString(arr: string[] | null): Uint8Array {
  if (arr === null) return new Uint8Array([0]);
  const parts: Uint8Array[] = [new Uint8Array([1])];
  parts.push(encodeVarint(arr.length));
  for (const s of arr) {
    parts.push(encodeString(s));
  }
  return concatBytes(parts);
}

export function encodeOptionF32(val: number | null): Uint8Array {
  if (val === null) return new Uint8Array([0]);
  const buf = new ArrayBuffer(5);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setFloat32(1, val, true);
  return new Uint8Array(buf);
}

export function encodeOptionI64(val: number | null): Uint8Array {
  if (val === null) return new Uint8Array([0]);
  const result = tryEncodeVarintI64(BigInt(val));
  if (!result.ok) {
    throw new Error(`Failed to encode i64: ${result.error}`);
  }
  const varintBytes = result.value.bytes;
  const combined = new Uint8Array(1 + varintBytes.length);
  combined[0] = 1;
  combined.set(varintBytes, 1);
  return combined;
}

// ============================================================================
// Manga/Chapter Encoders
// ============================================================================

export function encodeManga(manga: Manga): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeString(manga.key || manga.id || ""));
  parts.push(encodeString(manga.title || ""));
  parts.push(encodeOptionBytes(manga.cover || null));
  parts.push(encodeOptionVecString(manga.artists || null));
  parts.push(encodeOptionVecString(manga.authors || null));
  parts.push(encodeOptionBytes(manga.description || null));
  parts.push(encodeOptionBytes(manga.url || null));
  parts.push(encodeOptionVecString(manga.tags || null));
  parts.push(new Uint8Array([manga.status || 0]));
  parts.push(new Uint8Array([manga.nsfw || 0]));
  parts.push(new Uint8Array([manga.viewer || 0]));
  parts.push(new Uint8Array([0])); // update_strategy
  parts.push(new Uint8Array([0])); // next_update_time (None)
  parts.push(new Uint8Array([0])); // chapters (None)

  return concatBytes(parts);
}

export function encodeHashMap(map: Record<string, string>): Uint8Array {
  const entries = Object.entries(map);
  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(entries.length));
  for (const [key, value] of entries) {
    parts.push(encodeString(key));
    parts.push(encodeString(value));
  }
  return concatBytes(parts);
}

// Encode PageContext (HashMap<String, String>)
export function encodePageContext(context: Record<string, string> | null): Uint8Array {
  if (context === null) return new Uint8Array([0]); // None
  const mapBytes = encodeHashMap(context);
  const result = new Uint8Array(1 + mapBytes.length);
  result[0] = 1; // Some
  result.set(mapBytes, 1);
  return result;
}

export function encodeU16(val: number): Uint8Array {
  const buf = new ArrayBuffer(2);
  const view = new DataView(buf);
  view.setUint16(0, val, true);
  return new Uint8Array(buf);
}

export function encodeImageResponse(
  code: number,
  headers: Record<string, string>,
  requestUrl: string | null,
  requestHeaders: Record<string, string>,
  imageRid: number
): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeU16(code));
  parts.push(encodeHashMap(headers));
  parts.push(encodeOptionBytes(requestUrl));
  parts.push(encodeHashMap(requestHeaders));
  parts.push(encodeI32(imageRid));

  return concatBytes(parts);
}

export function encodeChapter(chapter: Chapter): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeString(chapter.key || chapter.id || ""));
  parts.push(encodeOptionBytes(chapter.title || null));
  parts.push(encodeOptionF32(chapter.chapterNumber ?? null));
  parts.push(encodeOptionF32(chapter.volumeNumber ?? null));
  parts.push(encodeOptionI64(chapter.dateUploaded ? Math.floor(chapter.dateUploaded / 1000) : null));

  if (chapter.scanlator) {
    parts.push(new Uint8Array([1]));
    parts.push(encodeVarint(1));
    parts.push(encodeString(chapter.scanlator));
  } else {
    parts.push(new Uint8Array([0]));
  }

  parts.push(encodeOptionBytes(chapter.url || null));
  parts.push(encodeOptionBytes(chapter.lang || null));
  parts.push(new Uint8Array([0])); // thumbnail (None)
  parts.push(new Uint8Array([0])); // locked (false)

  return concatBytes(parts);
}

// ============================================================================
// FilterValue Encoders
// ============================================================================

export function encodeFilterValue(filter: FilterValue): Uint8Array {
  const parts: Uint8Array[] = [];
  const id = filter.name || "";

  switch (filter.type) {
    case 0: // Title -> Text
    case 1: // Author -> Text
      parts.push(encodeVarint(0));
      parts.push(encodeString(id));
      parts.push(encodeString(String(filter.value || "")));
      break;

    case 3: {
      // Sort
      parts.push(encodeVarint(1));
      parts.push(encodeString(id));
      const sortVal = filter.value as { index: number; ascending: boolean } | undefined;
      parts.push(encodeI32(sortVal?.index ?? 0));
      parts.push(encodeBool(sortVal?.ascending ?? false));
      break;
    }

    case 4: // Check
      parts.push(encodeVarint(2));
      parts.push(encodeString(id));
      parts.push(encodeI32(filter.value ? 1 : 0));
      break;

    case 2: // Select
      parts.push(encodeVarint(3));
      parts.push(encodeString(id));
      parts.push(encodeString(String(filter.value ?? "")));
      break;

    case 6: {
      // Genre -> MultiSelect
      parts.push(encodeVarint(4));
      parts.push(encodeString(id));
      const multiVal = filter.value as { included?: string[]; excluded?: string[] } | undefined;
      parts.push(encodeVecString(multiVal?.included ?? []));
      parts.push(encodeVecString(multiVal?.excluded ?? []));
      break;
    }

    case 5: // Group
    default:
      parts.push(encodeVarint(0));
      parts.push(encodeString(id));
      parts.push(encodeString(""));
      break;
  }

  return concatBytes(parts);
}

export function encodeFilterValues(filters: FilterValue[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const validFilters = filters.filter((f) => f.type !== 5);
  parts.push(encodeVarint(validFilters.length));
  for (const filter of validFilters) {
    parts.push(encodeFilterValue(filter));
  }
  return concatBytes(parts);
}

/**
 * Decode a FilterValue from postcard format.
 * Returns [value, newOffset] or throws on error.
 */
export function decodeFilterValue(bytes: Uint8Array, pos: number): [FilterValue, number] {
  const [variant, variantEnd] = decodeVarint(bytes, pos);
  pos = variantEnd;

  let id: string;
  [id, pos] = decodeString(bytes, pos);

  switch (variant) {
    case 0: {
      // Text
      let value: string;
      [value, pos] = decodeString(bytes, pos);
      return [{ type: FilterType.Title, name: id, value }, pos];
    }
    case 1: {
      // Sort
      let index: number;
      let ascending: boolean;
      [index, pos] = decodeI32(bytes, pos);
      [ascending, pos] = decodeBool(bytes, pos);
      return [{ type: FilterType.Sort, name: id, value: { index, ascending } }, pos];
    }
    case 2: {
      // Check
      let value: number;
      [value, pos] = decodeI32(bytes, pos);
      return [{ type: FilterType.Check, name: id, value: value !== 0 }, pos];
    }
    case 3: {
      // Select
      let value: string;
      [value, pos] = decodeString(bytes, pos);
      return [{ type: FilterType.Select, name: id, value }, pos];
    }
    case 4: {
      // MultiSelect
      let included: string[];
      let excluded: string[];
      [included, pos] = decodeVec(bytes, pos, decodeString);
      [excluded, pos] = decodeVec(bytes, pos, decodeString);
      return [{ type: FilterType.Genre, name: id, value: { included, excluded } }, pos];
    }
    case 5: {
      // Range - skip Option<f32> from, Option<f32> to
      // We use Group type as a placeholder since Range isn't in FilterType
      const hasFrom = bytes[pos++];
      if (hasFrom === 1) pos += 4; // skip f32
      const hasTo = bytes[pos++];
      if (hasTo === 1) pos += 4; // skip f32
      return [{ type: FilterType.Group, name: id }, pos];
    }
    default:
      throw new Error(`Unknown FilterValue variant: ${variant}`);
  }
}

// ============================================================================
// Home Layout Decoders
// ============================================================================

function decodeOptionFloat(bytes: Uint8Array, pos: number): [number | undefined, number] {
  const tag = bytes[pos];
  if (tag === 0) return [undefined, pos + 1];
  const view = new DataView(bytes.buffer, bytes.byteOffset + pos + 1, 4);
  return [view.getFloat32(0, true), pos + 5];
}

function decodeOptionInt(bytes: Uint8Array, pos: number): [number | undefined, number] {
  const tag = bytes[pos];
  if (tag === 0) return [undefined, pos + 1];
  const [val, newPos] = decodeVarint(bytes, pos + 1);
  return [val, newPos];
}

function decodeListing(bytes: Uint8Array, pos: number): [Listing, number] {
  let id: string, name: string;
  [id, pos] = decodeString(bytes, pos);
  [name, pos] = decodeString(bytes, pos);
  const kind = bytes[pos] as 0 | 1;
  pos += 1;
  return [{ id, name, kind }, pos];
}

function decodeOptionListing(bytes: Uint8Array, pos: number): [Listing | undefined, number] {
  const tag = bytes[pos];
  if (tag === 0) return [undefined, pos + 1];
  return decodeListing(bytes, pos + 1);
}

function decodeHomeLink(bytes: Uint8Array, pos: number, sourceId: string): [HomeLink, number] {
  let title: string;
  let subtitle: string | null;
  let imageUrl: string | null;
  let value: HomeLinkValue | undefined;

  [title, pos] = decodeString(bytes, pos);
  [subtitle, pos] = decodeOptionString(bytes, pos);
  [imageUrl, pos] = decodeOptionString(bytes, pos);

  const hasValue = bytes[pos];
  pos += 1;

  if (hasValue === 1) {
    const valueType = bytes[pos];
    pos += 1;

    if (valueType === 0) {
      let url: string;
      [url, pos] = decodeString(bytes, pos);
      value = { type: "url", url };
    } else if (valueType === 1) {
      let listing: Listing;
      [listing, pos] = decodeListing(bytes, pos);
      value = { type: "listing", listing };
    } else if (valueType === 2) {
      const [decoded, newPos] = decodeManga(bytes, pos);
      pos = newPos;
      const manga: Manga = {
        sourceId,
        id: decoded.key,
        key: decoded.key,
        title: decoded.title || undefined,
        cover: decoded.cover || undefined,
        authors: decoded.authors || undefined,
        artists: decoded.artists || undefined,
        description: decoded.description || undefined,
        tags: decoded.tags || undefined,
        status: decoded.status as MangaStatus | undefined,
        nsfw: decoded.contentRating as ContentRating | undefined,
      };
      value = { type: "manga", manga };
    }
  }

  return [{ title, subtitle: subtitle ?? undefined, imageUrl: imageUrl ?? undefined, value }, pos];
}

function decodeHomeFilterItem(bytes: Uint8Array, pos: number): [HomeFilterItem, number] {
  let title: string;
  [title, pos] = decodeString(bytes, pos);

  const hasValues = bytes[pos];
  pos += 1;

  let values: FilterValue[] | undefined;
  if (hasValues === 1) {
    const [count, countEnd] = decodeVarint(bytes, pos);
    pos = countEnd;
    values = [];
    for (let i = 0; i < count; i++) {
      const [value, newPos] = decodeFilterValue(bytes, pos);
      values.push(value);
      pos = newPos;
    }
  }

  return [{ title, values }, pos];
}

function decodeMangaWithChapter(bytes: Uint8Array, pos: number, sourceId: string): [MangaWithChapter, number] {
  const [decodedManga, mangaEnd] = decodeManga(bytes, pos);
  pos = mangaEnd;

  const manga: Manga = {
    sourceId,
    id: decodedManga.key,
    key: decodedManga.key,
    title: decodedManga.title || undefined,
    cover: decodedManga.cover || undefined,
    authors: decodedManga.authors || undefined,
    description: decodedManga.description || undefined,
    tags: decodedManga.tags || undefined,
    status: decodedManga.status as MangaStatus | undefined,
  };

  // Chapter fields
  let chapterKey: string;
  let chapterTitle: string | null;
  let chapterNumber: number | undefined;
  let volumeNumber: number | undefined;
  let dateUploaded: number | undefined;
  let chapterScanlators: string[] | undefined;
  let chapterUrl: string | null;
  let chapterLang: string | null;

  [chapterKey, pos] = decodeString(bytes, pos);
  [chapterTitle, pos] = decodeOptionString(bytes, pos);

  // chapter_number: Option<f32>
  if (bytes[pos++] === 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
    chapterNumber = view.getFloat32(0, true);
    pos += 4;
  }

  // volume_number: Option<f32>
  if (bytes[pos++] === 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
    volumeNumber = view.getFloat32(0, true);
    pos += 4;
  }

  // date_uploaded: Option<i64>
  if (bytes[pos++] === 1) {
    const [date, dateEnd] = decodeVarint(bytes, pos);
    dateUploaded = date * 1000;
    pos = dateEnd;
  }

  // scanlators: Option<Vec<String>>
  if (bytes[pos++] === 1) {
    const [scanCount, scanEnd] = decodeVarint(bytes, pos);
    pos = scanEnd;
    chapterScanlators = [];
    for (let i = 0; i < scanCount; i++) {
      const [s, sEnd] = decodeString(bytes, pos);
      chapterScanlators.push(s);
      pos = sEnd;
    }
  }

  [chapterUrl, pos] = decodeOptionString(bytes, pos);
  [chapterLang, pos] = decodeOptionString(bytes, pos);

  // thumbnail: Option<String>
  const [, thumbnailEnd] = decodeOptionString(bytes, pos);
  pos = thumbnailEnd;

  // locked: bool
  pos += 1;

  const chapter: Chapter = {
    key: chapterKey,
    title: chapterTitle ?? undefined,
    scanlator: chapterScanlators?.join(", "),
    url: chapterUrl ?? undefined,
    lang: chapterLang ?? undefined,
    chapterNumber,
    volumeNumber,
    dateUploaded,
  };

  return [{ manga, chapter }, pos];
}

function decodeHomeComponentValue(bytes: Uint8Array, pos: number, sourceId: string): [HomeComponentValue, number] {
  const variant = bytes[pos];
  pos += 1;

  switch (variant) {
    case 0: { // ImageScroller
      const links: HomeLink[] = [];
      const [linkCount, linkEnd] = decodeVarint(bytes, pos);
      pos = linkEnd;
      for (let i = 0; i < linkCount; i++) {
        const [link, newPos] = decodeHomeLink(bytes, pos, sourceId);
        links.push(link);
        pos = newPos;
      }
      let autoScrollInterval: number | undefined;
      let width: number | undefined;
      let height: number | undefined;
      [autoScrollInterval, pos] = decodeOptionFloat(bytes, pos);
      [width, pos] = decodeOptionInt(bytes, pos);
      [height, pos] = decodeOptionInt(bytes, pos);
      return [{ type: "imageScroller", links, autoScrollInterval, width, height }, pos];
    }

    case 1: { // BigScroller
      const entries: Manga[] = [];
      const [entryCount, entryEnd] = decodeVarint(bytes, pos);
      pos = entryEnd;
      for (let i = 0; i < entryCount; i++) {
        const [decoded, newPos] = decodeManga(bytes, pos);
        pos = newPos;
        entries.push({
          sourceId,
          id: decoded.key,
          key: decoded.key,
          title: decoded.title || undefined,
          cover: decoded.cover || undefined,
          authors: decoded.authors || undefined,
          artists: decoded.artists || undefined,
          description: decoded.description || undefined,
          tags: decoded.tags || undefined,
          status: decoded.status as MangaStatus | undefined,
          nsfw: decoded.contentRating as ContentRating | undefined,
        });
      }
      let autoScrollInterval: number | undefined;
      [autoScrollInterval, pos] = decodeOptionFloat(bytes, pos);
      return [{ type: "bigScroller", entries, autoScrollInterval }, pos];
    }

    case 2: { // Scroller
      const entries: HomeLink[] = [];
      const [entryCount, entryEnd] = decodeVarint(bytes, pos);
      pos = entryEnd;
      for (let i = 0; i < entryCount; i++) {
        const [link, newPos] = decodeHomeLink(bytes, pos, sourceId);
        entries.push(link);
        pos = newPos;
      }
      let listing: Listing | undefined;
      [listing, pos] = decodeOptionListing(bytes, pos);
      return [{ type: "scroller", entries, listing }, pos];
    }

    case 3: { // MangaList
      const ranking = bytes[pos] === 1;
      pos += 1;
      let pageSize: number | undefined;
      [pageSize, pos] = decodeOptionInt(bytes, pos);
      const entries: HomeLink[] = [];
      const [entryCount, entryEnd] = decodeVarint(bytes, pos);
      pos = entryEnd;
      for (let i = 0; i < entryCount; i++) {
        const [link, newPos] = decodeHomeLink(bytes, pos, sourceId);
        entries.push(link);
        pos = newPos;
      }
      let listing: Listing | undefined;
      [listing, pos] = decodeOptionListing(bytes, pos);
      return [{ type: "mangaList", ranking, pageSize, entries, listing }, pos];
    }

    case 4: { // MangaChapterList
      let pageSize: number | undefined;
      [pageSize, pos] = decodeOptionInt(bytes, pos);
      const entries: MangaWithChapter[] = [];
      const [entryCount, entryEnd] = decodeVarint(bytes, pos);
      pos = entryEnd;
      for (let i = 0; i < entryCount; i++) {
        const [entry, newPos] = decodeMangaWithChapter(bytes, pos, sourceId);
        entries.push(entry);
        pos = newPos;
      }
      let listing: Listing | undefined;
      [listing, pos] = decodeOptionListing(bytes, pos);
      return [{ type: "mangaChapterList", pageSize, entries, listing }, pos];
    }

    case 5: { // Filters
      const items: HomeFilterItem[] = [];
      const [itemCount, itemEnd] = decodeVarint(bytes, pos);
      pos = itemEnd;
      for (let i = 0; i < itemCount; i++) {
        const [item, newPos] = decodeHomeFilterItem(bytes, pos);
        items.push(item);
        pos = newPos;
      }
      return [{ type: "filters", items }, pos];
    }

    case 6: { // Links
      const links: HomeLink[] = [];
      const [linkCount, linkEnd] = decodeVarint(bytes, pos);
      pos = linkEnd;
      for (let i = 0; i < linkCount; i++) {
        const [link, newPos] = decodeHomeLink(bytes, pos, sourceId);
        links.push(link);
        pos = newPos;
      }
      return [{ type: "links", links }, pos];
    }

    default:
      throw new Error(`Unknown HomeComponentValue variant: ${variant}`);
  }
}

export function decodeHomeComponent(bytes: Uint8Array, pos: number, sourceId: string): [HomeComponent, number] {
  let title: string | null;
  let subtitle: string | null;
  let value: HomeComponentValue;

  [title, pos] = decodeOptionString(bytes, pos);
  [subtitle, pos] = decodeOptionString(bytes, pos);
  [value, pos] = decodeHomeComponentValue(bytes, pos, sourceId);

  return [{ title: title ?? undefined, subtitle: subtitle ?? undefined, value }, pos];
}

export function decodeHomeLayout(bytes: Uint8Array, sourceId: string): HomeLayout {
  let pos = 0;
  const [componentCount, countEnd] = decodeVarint(bytes, pos);
  pos = countEnd;

  const components: HomeComponent[] = [];
  for (let i = 0; i < componentCount; i++) {
    const [component, newPos] = decodeHomeComponent(bytes, pos, sourceId);
    components.push(component);
    pos = newPos;
  }

  return { components };
}
