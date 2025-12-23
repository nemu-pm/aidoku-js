/**
 * Canvas namespace - for bitmap operations (Node.js version)
 * Uses the `canvas` npm package (node-canvas) for Node.js/Bun compatibility
 */
import type { GlobalStore } from "../global-store";
import { decodeF32, decodeVarint, decodeVec } from "../postcard";

// Canvas error codes matching Rust CanvasError
const CanvasError = {
  InvalidContext: -1,
  InvalidImagePointer: -2,
  InvalidImage: -3,
  InvalidSrcRect: -4,
  InvalidResult: -5,
  InvalidBounds: -6,
  InvalidPath: -7,
  InvalidStyle: -8,
  InvalidString: -9,
  InvalidFont: -10,
  FontLoadFailed: -11,
} as const;

// ============================================================================
// Postcard decoders for Path and StrokeStyle
// ============================================================================

interface Point {
  x: number;
  y: number;
}

function decodePoint(bytes: Uint8Array, offset: number): [Point, number] {
  let pos = offset;
  let x: number, y: number;
  [x, pos] = decodeF32(bytes, pos);
  [y, pos] = decodeF32(bytes, pos);
  return [{ x, y }, pos];
}

type PathOp =
  | { type: "moveTo"; point: Point }
  | { type: "lineTo"; point: Point }
  | { type: "quadTo"; to: Point; control: Point }
  | { type: "cubicTo"; to: Point; c1: Point; c2: Point }
  | { type: "arc"; center: Point; radius: number; startAngle: number; sweepAngle: number }
  | { type: "close" };

function decodePathOp(bytes: Uint8Array, offset: number): [PathOp, number] {
  let pos = offset;
  const [variant, variantEnd] = decodeVarint(bytes, pos);
  pos = variantEnd;

  switch (variant) {
    case 0: {
      const [point, pointEnd] = decodePoint(bytes, pos);
      return [{ type: "moveTo", point }, pointEnd];
    }
    case 1: {
      const [point, pointEnd] = decodePoint(bytes, pos);
      return [{ type: "lineTo", point }, pointEnd];
    }
    case 2: {
      const [to, toEnd] = decodePoint(bytes, pos);
      const [control, controlEnd] = decodePoint(bytes, toEnd);
      return [{ type: "quadTo", to, control }, controlEnd];
    }
    case 3: {
      const [to, toEnd] = decodePoint(bytes, pos);
      const [c1, c1End] = decodePoint(bytes, toEnd);
      const [c2, c2End] = decodePoint(bytes, c1End);
      return [{ type: "cubicTo", to, c1, c2 }, c2End];
    }
    case 4: {
      const [center, centerEnd] = decodePoint(bytes, pos);
      let radius: number, startAngle: number, sweepAngle: number;
      [radius, pos] = decodeF32(bytes, centerEnd);
      [startAngle, pos] = decodeF32(bytes, pos);
      [sweepAngle, pos] = decodeF32(bytes, pos);
      return [{ type: "arc", center, radius, startAngle, sweepAngle }, pos];
    }
    case 5:
      return [{ type: "close" }, pos];
    default:
      throw new Error(`Unknown PathOp variant: ${variant}`);
  }
}

interface DecodedPath {
  ops: PathOp[];
}

function decodePath(bytes: Uint8Array, offset: number): [DecodedPath, number] {
  const [ops, opsEnd] = decodeVec(bytes, offset, decodePathOp);
  return [{ ops }, opsEnd];
}

interface Color {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function decodeColor(bytes: Uint8Array, offset: number): [Color, number] {
  let pos = offset;
  let red: number, green: number, blue: number, alpha: number;
  [red, pos] = decodeF32(bytes, pos);
  [green, pos] = decodeF32(bytes, pos);
  [blue, pos] = decodeF32(bytes, pos);
  [alpha, pos] = decodeF32(bytes, pos);
  return [{ red, green, blue, alpha }, pos];
}

type LineCap = "round" | "square" | "butt";
function decodeLineCap(bytes: Uint8Array, offset: number): [LineCap, number] {
  const [variant, variantEnd] = decodeVarint(bytes, offset);
  const caps: LineCap[] = ["round", "square", "butt"];
  return [caps[variant] || "butt", variantEnd];
}

type LineJoin = "round" | "bevel" | "miter";
function decodeLineJoin(bytes: Uint8Array, offset: number): [LineJoin, number] {
  const [variant, variantEnd] = decodeVarint(bytes, offset);
  const joins: LineJoin[] = ["round", "bevel", "miter"];
  return [joins[variant] || "miter", variantEnd];
}

interface StrokeStyleDecoded {
  color: Color;
  width: number;
  cap: LineCap;
  join: LineJoin;
  miterLimit: number;
  dashArray: number[];
  dashOffset: number;
}

function decodeStrokeStyle(bytes: Uint8Array, offset: number): [StrokeStyleDecoded, number] {
  let pos = offset;
  let color: Color;
  let width: number, miterLimit: number, dashOffset: number;
  let cap: LineCap, join: LineJoin;
  let dashArray: number[];

  [color, pos] = decodeColor(bytes, pos);
  [width, pos] = decodeF32(bytes, pos);
  [cap, pos] = decodeLineCap(bytes, pos);
  [join, pos] = decodeLineJoin(bytes, pos);
  [miterLimit, pos] = decodeF32(bytes, pos);
  [dashArray, pos] = decodeVec(bytes, pos, decodeF32);
  [dashOffset, pos] = decodeF32(bytes, pos);

  return [{ color, width, cap, join, miterLimit, dashArray, dashOffset }, pos];
}

function readItemBytes(store: GlobalStore, ptr: number): Uint8Array | null {
  if (ptr <= 0 || !store.memory) return null;
  try {
    const view = new DataView(store.memory.buffer);
    const len = view.getUint32(ptr, true);
    if (len <= 8) return null;
    const dataLen = len - 8;
    return new Uint8Array(store.memory.buffer, ptr + 8, dataLen).slice();
  } catch {
    return null;
  }
}

function encodeRGBAasPNG(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c;
  }
  const crc32 = (data: Uint8Array): number => {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };

  const makeChunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = new TextEncoder().encode(type);
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length, false);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcData = new Uint8Array(4 + data.length);
    crcData.set(typeBytes, 0);
    crcData.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcData), false);
    return chunk;
  };

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ihdrChunk = makeChunk("IHDR", ihdr);

  const rawData = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = rgba[srcIdx];
      rawData[dstIdx + 1] = rgba[srcIdx + 1];
      rawData[dstIdx + 2] = rgba[srcIdx + 2];
      rawData[dstIdx + 3] = rgba[srcIdx + 3];
    }
  }

  const deflateBlocks: Uint8Array[] = [];
  const BLOCK_SIZE = 65535;
  for (let i = 0; i < rawData.length; i += BLOCK_SIZE) {
    const isLast = i + BLOCK_SIZE >= rawData.length;
    const blockData = rawData.slice(i, Math.min(i + BLOCK_SIZE, rawData.length));
    const blockLen = blockData.length;
    const block = new Uint8Array(5 + blockLen);
    block[0] = isLast ? 1 : 0;
    block[1] = blockLen & 0xff;
    block[2] = (blockLen >> 8) & 0xff;
    block[3] = ~blockLen & 0xff;
    block[4] = (~blockLen >> 8) & 0xff;
    block.set(blockData, 5);
    deflateBlocks.push(block);
  }

  let s1 = 1, s2 = 0;
  for (let i = 0; i < rawData.length; i++) {
    s1 = (s1 + rawData[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler32 = ((s2 << 16) | s1) >>> 0;

  const deflateLen = deflateBlocks.reduce((sum, b) => sum + b.length, 0);
  const zlibData = new Uint8Array(2 + deflateLen + 4);
  zlibData[0] = 0x78;
  zlibData[1] = 0x01;
  let offset = 2;
  for (const block of deflateBlocks) {
    zlibData.set(block, offset);
    offset += block.length;
  }
  const adlerView = new DataView(zlibData.buffer, zlibData.byteOffset + offset, 4);
  adlerView.setUint32(0, adler32, false);

  const idatChunk = makeChunk("IDAT", zlibData);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  );
  let pos = 0;
  png.set(signature, pos);
  pos += signature.length;
  png.set(ihdrChunk, pos);
  pos += ihdrChunk.length;
  png.set(idatChunk, pos);
  pos += idatChunk.length;
  png.set(iendChunk, pos);

  return png;
}

// ============================================================================
// Canvas module - using node-canvas
// ============================================================================

import { createCanvas, loadImage, registerFont, type Canvas, type Image, type CanvasRenderingContext2D } from "canvas";

// Module state
let canvasInitialized = false;

export async function initCanvasModule(): Promise<boolean> {
  canvasInitialized = true;
  return true;
}

function isCanvasAvailable(): boolean {
  return canvasInitialized;
}

// Type aliases for clarity
type NodeCanvas = Canvas;
type NodeImage = Image;
type NodeCanvasContext = CanvasRenderingContext2D;

// ============================================================================
// Internal resource types
// ============================================================================

interface CanvasContext {
  type: "canvas";
  canvas: NodeCanvas;
  ctx: NodeCanvasContext;
}

interface ImageResource {
  type: "image";
  image: NodeImage | null;
  data: Uint8Array;
  width: number;
  height: number;
}

interface FontResource {
  type: "font";
  family: string;
  weight?: number;
}

function isCanvasContext(r: unknown): r is CanvasContext {
  return r !== null && typeof r === "object" && (r as CanvasContext).type === "canvas";
}

function isImageResource(r: unknown): r is ImageResource {
  return r !== null && typeof r === "object" && (r as ImageResource).type === "image";
}

function isFontResource(r: unknown): r is FontResource {
  return r !== null && typeof r === "object" && (r as FontResource).type === "font";
}

function applyPathToContext(ctx: NodeCanvasContext, decodedPath: DecodedPath): void {
  ctx.beginPath();
  for (const op of decodedPath.ops) {
    switch (op.type) {
      case "moveTo":
        ctx.moveTo(op.point.x, op.point.y);
        break;
      case "lineTo":
        ctx.lineTo(op.point.x, op.point.y);
        break;
      case "quadTo":
        ctx.quadraticCurveTo(op.control.x, op.control.y, op.to.x, op.to.y);
        break;
      case "cubicTo":
        ctx.bezierCurveTo(op.c1.x, op.c1.y, op.c2.x, op.c2.y, op.to.x, op.to.y);
        break;
      case "arc":
        ctx.arc(op.center.x, op.center.y, op.radius, op.startAngle, op.startAngle + op.sweepAngle, op.sweepAngle < 0);
        break;
      case "close":
        ctx.closePath();
        break;
    }
  }
}

// ============================================================================
// Exported functions
// ============================================================================

export async function createHostImage(
  store: GlobalStore,
  imageData: Uint8Array
): Promise<{ rid: number; width: number; height: number } | null> {
  const dataCopy = new Uint8Array(imageData);

  try {
    const img = await loadImage(Buffer.from(dataCopy));
    const resource: ImageResource = {
      type: "image",
      image: img,
      data: dataCopy,
      width: img.width,
      height: img.height,
    };
    const rid = store.storeStdValue(resource);
    return { rid, width: img.width, height: img.height };
  } catch {
    console.warn("[Canvas] createHostImage: decode failed, storing raw bytes");
    const resource: ImageResource = {
      type: "image",
      image: null,
      data: dataCopy,
      width: 0,
      height: 0,
    };
    const rid = store.storeStdValue(resource);
    return { rid, width: 0, height: 0 };
  }
}

export function getHostImageData(store: GlobalStore, rid: number): Uint8Array | null {
  const resource = store.readStdValue(rid);
  if (!isImageResource(resource)) return null;

  if (resource.image && isCanvasAvailable()) {
    try {
      const canvasObj = createCanvas(resource.image.width, resource.image.height);
      const ctx = canvasObj.getContext("2d");
      ctx.drawImage(resource.image, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvasObj.width, canvasObj.height);
      return encodeRGBAasPNG(imageData.data, canvasObj.width, canvasObj.height);
    } catch {
      return resource.data;
    }
  }

  return resource.data;
}

export function createCanvasImports(store: GlobalStore) {
  const getCanvasCtx = (rid: number): CanvasContext | null => {
    const resource = store.readStdValue(rid);
    return isCanvasContext(resource) ? resource : null;
  };

  const getImage = (rid: number): ImageResource | null => {
    const resource = store.readStdValue(rid);
    return isImageResource(resource) ? resource : null;
  };

  const getFont = (rid: number): FontResource | null => {
    const resource = store.readStdValue(rid);
    return isFontResource(resource) ? resource : null;
  };

  const startImageDecode = async (rid: number, data: Uint8Array): Promise<void> => {
    try {
      const img = await loadImage(Buffer.from(data));
      const image = getImage(rid);
      if (image) {
        image.image = img;
        image.width = img.width;
        image.height = img.height;
      }
    } catch {
      console.warn("[Canvas] Image decode failed for rid:", rid);
    }
  };

  return {
    new_context: (width: number, height: number): number => {
      if (!isCanvasAvailable()) return CanvasError.InvalidContext;
      try {
        const canvasObj = createCanvas(Math.max(1, width), Math.max(1, height));
        const ctx = canvasObj.getContext("2d");
        const resource: CanvasContext = { type: "canvas", canvas: canvasObj, ctx };
        return store.storeStdValue(resource);
      } catch {
        return CanvasError.InvalidContext;
      }
    },

    set_transform: (ctxId: number, translateX: number, translateY: number, scaleX: number, scaleY: number, rotateAngle: number): number => {
      const canvasCtx = getCanvasCtx(ctxId);
      if (!canvasCtx) return CanvasError.InvalidContext;
      try {
        const { ctx } = canvasCtx;
        ctx.resetTransform();
        ctx.translate(translateX, translateY);
        ctx.rotate(rotateAngle);
        ctx.scale(scaleX, scaleY);
        return 0;
      } catch {
        return CanvasError.InvalidContext;
      }
    },

    copy_image: (ctxId: number, imageId: number, srcX: number, srcY: number, srcWidth: number, srcHeight: number, dstX: number, dstY: number, dstWidth: number, dstHeight: number): number => {
      const canvasCtx = getCanvasCtx(ctxId);
      if (!canvasCtx) return CanvasError.InvalidContext;
      const image = getImage(imageId);
      if (!image || !image.image) return CanvasError.InvalidImage;
      try {
        canvasCtx.ctx.drawImage(image.image, srcX, srcY, srcWidth, srcHeight, dstX, dstY, dstWidth, dstHeight);
        return 0;
      } catch {
        return CanvasError.InvalidSrcRect;
      }
    },

    draw_image: (ctxId: number, imageId: number, dstX: number, dstY: number, dstWidth: number, dstHeight: number): number => {
      const canvasCtx = getCanvasCtx(ctxId);
      if (!canvasCtx) return CanvasError.InvalidContext;
      const image = getImage(imageId);
      if (!image || !image.image) return CanvasError.InvalidImage;
      try {
        canvasCtx.ctx.drawImage(image.image, dstX, dstY, dstWidth, dstHeight);
        return 0;
      } catch {
        return CanvasError.InvalidBounds;
      }
    },

    fill: (ctxId: number, pathPtr: number, r: number, g: number, b: number, a: number): number => {
      const canvasCtx = getCanvasCtx(ctxId);
      if (!canvasCtx) return CanvasError.InvalidContext;
      if (pathPtr <= 0) return CanvasError.InvalidPath;
      try {
        const pathBytes = readItemBytes(store, pathPtr);
        if (!pathBytes) return CanvasError.InvalidPath;
        const [decodedPath] = decodePath(pathBytes, 0);
        const { ctx } = canvasCtx;
        ctx.fillStyle = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
        applyPathToContext(ctx, decodedPath);
        ctx.fill();
        return 0;
      } catch (e) {
        console.error("[Canvas] fill error:", e);
        return CanvasError.InvalidPath;
      }
    },

    stroke: (ctxId: number, pathPtr: number, stylePtr: number): number => {
      const canvasCtx = getCanvasCtx(ctxId);
      if (!canvasCtx) return CanvasError.InvalidContext;
      if (pathPtr <= 0) return CanvasError.InvalidPath;
      if (stylePtr <= 0) return CanvasError.InvalidStyle;
      try {
        const pathBytes = readItemBytes(store, pathPtr);
        if (!pathBytes) return CanvasError.InvalidPath;
        const styleBytes = readItemBytes(store, stylePtr);
        if (!styleBytes) return CanvasError.InvalidStyle;
        const [decodedPath] = decodePath(pathBytes, 0);
        const [style] = decodeStrokeStyle(styleBytes, 0);
        const { ctx } = canvasCtx;
        const { red, green, blue, alpha } = style.color;
        ctx.strokeStyle = `rgba(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}, ${alpha})`;
        ctx.lineWidth = style.width;
        ctx.lineCap = style.cap;
        ctx.lineJoin = style.join;
        ctx.miterLimit = style.miterLimit;
        if (style.dashArray.length > 0) {
          ctx.setLineDash(style.dashArray);
          ctx.lineDashOffset = style.dashOffset;
        }
        applyPathToContext(ctx, decodedPath);
        ctx.stroke();
        return 0;
      } catch (e) {
        console.error("[Canvas] stroke error:", e);
        return CanvasError.InvalidStyle;
      }
    },

    draw_text: (ctxId: number, textPtr: number, textLen: number, fontSize: number, x: number, y: number, fontId: number, r: number, g: number, b: number, a: number): number => {
      const canvasCtx = getCanvasCtx(ctxId);
      if (!canvasCtx) return CanvasError.InvalidContext;
      const text = store.readString(textPtr, textLen);
      if (!text) return CanvasError.InvalidString;
      const font = getFont(fontId);
      const fontFamily = font?.family ?? "sans-serif";
      try {
        const { ctx } = canvasCtx;
        ctx.font = `${fontSize}px "${fontFamily}"`;
        ctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
        ctx.fillText(text, x, y);
        return 0;
      } catch {
        return CanvasError.InvalidFont;
      }
    },

    get_image: (ctxId: number): number => {
      const canvasCtx = getCanvasCtx(ctxId);
      if (!canvasCtx) return CanvasError.InvalidContext;
      try {
        const { canvas: canvasObj, ctx } = canvasCtx;
        const imageData = ctx.getImageData(0, 0, canvasObj.width, canvasObj.height);
        const resource: ImageResource = {
          type: "image",
          image: null,
          data: new Uint8Array(imageData.data),
          width: canvasObj.width,
          height: canvasObj.height,
        };
        return store.storeStdValue(resource);
      } catch {
        return CanvasError.InvalidResult;
      }
    },

    new_font: (familyPtr: number, familyLen: number): number => {
      const family = store.readString(familyPtr, familyLen);
      if (!family) return CanvasError.InvalidString;
      const resource: FontResource = { type: "font", family };
      return store.storeStdValue(resource);
    },

    system_font: (weight: number): number => {
      const weightMap: Record<number, number> = { 0: 100, 1: 200, 2: 300, 3: 400, 4: 500, 5: 600, 6: 700, 7: 800, 8: 900 };
      const cssWeight = weightMap[weight] ?? 400;
      const resource: FontResource = { type: "font", family: "sans-serif", weight: cssWeight };
      return store.storeStdValue(resource);
    },

    load_font: (urlPtr: number, urlLen: number): number => {
      const url = store.readString(urlPtr, urlLen);
      if (!url) return CanvasError.InvalidString;
      const fontFamily = `loaded-font-${Date.now()}`;
      if (isCanvasAvailable()) {
        try {
          registerFont(url, { family: fontFamily });
        } catch {
          console.warn(`[Canvas] Failed to register font from ${url}`);
        }
      }
      const resource: FontResource = { type: "font", family: fontFamily };
      return store.storeStdValue(resource);
    },

    new_image: (dataPtr: number, dataLen: number): number => {
      const data = store.readBytes(dataPtr, dataLen);
      if (!data) return CanvasError.InvalidImagePointer;
      try {
        const dataCopy = new Uint8Array(data);
        const resource: ImageResource = { type: "image", image: null, data: dataCopy, width: 0, height: 0 };
        const rid = store.storeStdValue(resource);
        startImageDecode(rid, dataCopy);
        return rid;
      } catch {
        return CanvasError.InvalidImage;
      }
    },

    get_image_data: (imageId: number): number => {
      const image = getImage(imageId);
      if (!image) return CanvasError.InvalidImage;
      try {
        if (image.image && isCanvasAvailable()) {
          const canvasObj = createCanvas(image.image.width, image.image.height);
          const ctx = canvasObj.getContext("2d");
          ctx.drawImage(image.image, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvasObj.width, canvasObj.height);
          const pngBytes = encodeRGBAasPNG(imageData.data, canvasObj.width, canvasObj.height);
          return store.storeStdValue(pngBytes);
        }
        return store.storeStdValue(image.data);
      } catch {
        return CanvasError.InvalidResult;
      }
    },

    get_image_width: (imageId: number): number => {
      const image = getImage(imageId);
      return image?.width ?? 0;
    },

    get_image_height: (imageId: number): number => {
      const image = getImage(imageId);
      return image?.height ?? 0;
    },
  };
}
