/**
 * Canvas namespace - for bitmap operations
 * Used by sources for image manipulation/descrambling
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
      // MoveTo
      const [point, pointEnd] = decodePoint(bytes, pos);
      return [{ type: "moveTo", point }, pointEnd];
    }
    case 1: {
      // LineTo
      const [point, pointEnd] = decodePoint(bytes, pos);
      return [{ type: "lineTo", point }, pointEnd];
    }
    case 2: {
      // QuadTo(to, control)
      const [to, toEnd] = decodePoint(bytes, pos);
      const [control, controlEnd] = decodePoint(bytes, toEnd);
      return [{ type: "quadTo", to, control }, controlEnd];
    }
    case 3: {
      // CubicTo(to, c1, c2)
      const [to, toEnd] = decodePoint(bytes, pos);
      const [c1, c1End] = decodePoint(bytes, toEnd);
      const [c2, c2End] = decodePoint(bytes, c1End);
      return [{ type: "cubicTo", to, c1, c2 }, c2End];
    }
    case 4: {
      // Arc(center, radius, start, sweep)
      const [center, centerEnd] = decodePoint(bytes, pos);
      let radius: number, startAngle: number, sweepAngle: number;
      [radius, pos] = decodeF32(bytes, centerEnd);
      [startAngle, pos] = decodeF32(bytes, pos);
      [sweepAngle, pos] = decodeF32(bytes, pos);
      return [{ type: "arc", center, radius, startAngle, sweepAngle }, pos];
    }
    case 5: // Close
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

/**
 * Convert decoded Path to browser Path2D
 */
function pathToPath2D(decodedPath: DecodedPath): Path2D {
  const path = new Path2D();
  for (const op of decodedPath.ops) {
    switch (op.type) {
      case "moveTo":
        path.moveTo(op.point.x, op.point.y);
        break;
      case "lineTo":
        path.lineTo(op.point.x, op.point.y);
        break;
      case "quadTo":
        path.quadraticCurveTo(op.control.x, op.control.y, op.to.x, op.to.y);
        break;
      case "cubicTo":
        path.bezierCurveTo(op.c1.x, op.c1.y, op.c2.x, op.c2.y, op.to.x, op.to.y);
        break;
      case "arc":
        path.arc(
          op.center.x,
          op.center.y,
          op.radius,
          op.startAngle,
          op.startAngle + op.sweepAngle,
          op.sweepAngle < 0
        );
        break;
      case "close":
        path.closePath();
        break;
    }
  }
  return path;
}

/**
 * Read postcard-encoded bytes from a Ptr (memory pointer).
 */
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

/**
 * Encode RGBA data as PNG (minimal uncompressed PNG for sync operation).
 */
function encodeRGBAasPNG(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  // PNG signature
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // Helper to compute CRC32
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

  // Create chunk helper
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

  // IHDR chunk
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // IDAT chunk (uncompressed with zlib wrapper)
  const rawData = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = rgba[srcIdx];
      rawData[dstIdx + 1] = rgba[srcIdx + 1];
      rawData[dstIdx + 2] = rgba[srcIdx + 2];
      rawData[dstIdx + 3] = rgba[srcIdx + 3];
    }
  }

  // Simple DEFLATE: store blocks (no compression)
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

  // Compute Adler-32
  let s1 = 1,
    s2 = 0;
  for (let i = 0; i < rawData.length; i++) {
    s1 = (s1 + rawData[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler32 = ((s2 << 16) | s1) >>> 0;

  // Build zlib stream
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

  // IEND chunk
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  // Combine all chunks
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

// Internal types for stored canvas resources
interface CanvasContext {
  type: "canvas";
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
}

interface ImageResource {
  type: "image";
  bitmap: ImageBitmap | null;
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

// Pending image decode operations
const pendingDecodes = new Map<number, Promise<ImageBitmap>>();

/**
 * Create an image resource directly from the host side (for processPageImage).
 */
export async function createHostImage(
  store: GlobalStore,
  imageData: Uint8Array
): Promise<{ rid: number; width: number; height: number } | null> {
  const dataCopy = new Uint8Array(imageData);

  try {
    const blob = new Blob([dataCopy.buffer as ArrayBuffer]);
    const bitmap = await createImageBitmap(blob);

    const resource: ImageResource = {
      type: "image",
      bitmap,
      data: dataCopy,
      width: bitmap.width,
      height: bitmap.height,
    };
    const rid = store.storeStdValue(resource);

    return { rid, width: bitmap.width, height: bitmap.height };
  } catch {
    console.warn("[Canvas] createHostImage: decode failed, storing raw bytes");
    const resource: ImageResource = {
      type: "image",
      bitmap: null,
      data: dataCopy,
      width: 0,
      height: 0,
    };
    const rid = store.storeStdValue(resource);

    return { rid, width: 0, height: 0 };
  }
}

/**
 * Get image data from an image resource by rid.
 */
export function getHostImageData(store: GlobalStore, rid: number): Uint8Array | null {
  const resource = store.readStdValue(rid);
  if (!isImageResource(resource)) return null;

  if (resource.bitmap) {
    try {
      const canvas = new OffscreenCanvas(resource.bitmap.width, resource.bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return resource.data;

      ctx.drawImage(resource.bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return encodeRGBAasPNG(imageData.data, canvas.width, canvas.height);
    } catch {
      return resource.data;
    }
  }

  return resource.data;
}

export function createCanvasImports(store: GlobalStore) {
  const getCanvas = (rid: number): CanvasContext | null => {
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

  const startImageDecode = (rid: number, data: Uint8Array): void => {
    const blob = new Blob([data.buffer as ArrayBuffer]);
    const promise = createImageBitmap(blob).then((bitmap) => {
      const image = getImage(rid);
      if (image) {
        image.bitmap = bitmap;
        image.width = bitmap.width;
        image.height = bitmap.height;
      }
      pendingDecodes.delete(rid);
      return bitmap;
    });
    pendingDecodes.set(rid, promise);
  };

  return {
    new_context: (width: number, height: number): number => {
      try {
        const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
        const ctx = canvas.getContext("2d");
        if (!ctx) return CanvasError.InvalidContext;
        const resource: CanvasContext = { type: "canvas", canvas, ctx };
        return store.storeStdValue(resource);
      } catch {
        return CanvasError.InvalidContext;
      }
    },

    set_transform: (
      ctxId: number,
      translateX: number,
      translateY: number,
      scaleX: number,
      scaleY: number,
      rotateAngle: number
    ): number => {
      const canvas = getCanvas(ctxId);
      if (!canvas) return CanvasError.InvalidContext;

      try {
        const { ctx } = canvas;
        ctx.resetTransform();
        ctx.translate(translateX, translateY);
        ctx.rotate(rotateAngle);
        ctx.scale(scaleX, scaleY);
        return 0;
      } catch {
        return CanvasError.InvalidContext;
      }
    },

    copy_image: (
      ctxId: number,
      imageId: number,
      srcX: number,
      srcY: number,
      srcWidth: number,
      srcHeight: number,
      dstX: number,
      dstY: number,
      dstWidth: number,
      dstHeight: number
    ): number => {
      const canvas = getCanvas(ctxId);
      if (!canvas) return CanvasError.InvalidContext;

      const image = getImage(imageId);
      if (!image) return CanvasError.InvalidImage;
      if (!image.bitmap) return CanvasError.InvalidImage;

      try {
        canvas.ctx.drawImage(
          image.bitmap,
          srcX,
          srcY,
          srcWidth,
          srcHeight,
          dstX,
          dstY,
          dstWidth,
          dstHeight
        );
        return 0;
      } catch {
        return CanvasError.InvalidSrcRect;
      }
    },

    draw_image: (
      ctxId: number,
      imageId: number,
      dstX: number,
      dstY: number,
      dstWidth: number,
      dstHeight: number
    ): number => {
      const canvas = getCanvas(ctxId);
      if (!canvas) return CanvasError.InvalidContext;

      const image = getImage(imageId);
      if (!image) return CanvasError.InvalidImage;
      if (!image.bitmap) return CanvasError.InvalidImage;

      try {
        canvas.ctx.drawImage(image.bitmap, dstX, dstY, dstWidth, dstHeight);
        return 0;
      } catch {
        return CanvasError.InvalidBounds;
      }
    },

    fill: (ctxId: number, pathPtr: number, r: number, g: number, b: number, a: number): number => {
      const canvas = getCanvas(ctxId);
      if (!canvas) return CanvasError.InvalidContext;
      if (pathPtr <= 0) return CanvasError.InvalidPath;

      try {
        const pathBytes = readItemBytes(store, pathPtr);
        if (!pathBytes) return CanvasError.InvalidPath;

        const [decodedPath] = decodePath(pathBytes, 0);
        const path2d = pathToPath2D(decodedPath);

        const { ctx } = canvas;
        const color = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
        ctx.fillStyle = color;
        ctx.fill(path2d);
        return 0;
      } catch (e) {
        console.error("[Canvas] fill error:", e);
        return CanvasError.InvalidPath;
      }
    },

    stroke: (ctxId: number, pathPtr: number, stylePtr: number): number => {
      const canvas = getCanvas(ctxId);
      if (!canvas) return CanvasError.InvalidContext;
      if (pathPtr <= 0) return CanvasError.InvalidPath;
      if (stylePtr <= 0) return CanvasError.InvalidStyle;

      try {
        const pathBytes = readItemBytes(store, pathPtr);
        if (!pathBytes) return CanvasError.InvalidPath;

        const styleBytes = readItemBytes(store, stylePtr);
        if (!styleBytes) return CanvasError.InvalidStyle;

        const [decodedPath] = decodePath(pathBytes, 0);
        const [style] = decodeStrokeStyle(styleBytes, 0);

        const path2d = pathToPath2D(decodedPath);
        const { ctx } = canvas;

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

        ctx.stroke(path2d);
        return 0;
      } catch (e) {
        console.error("[Canvas] stroke error:", e);
        return CanvasError.InvalidStyle;
      }
    },

    draw_text: (
      ctxId: number,
      textPtr: number,
      textLen: number,
      fontSize: number,
      x: number,
      y: number,
      fontId: number,
      r: number,
      g: number,
      b: number,
      a: number
    ): number => {
      const canvas = getCanvas(ctxId);
      if (!canvas) return CanvasError.InvalidContext;

      const text = store.readString(textPtr, textLen);
      if (!text) return CanvasError.InvalidString;

      const font = getFont(fontId);
      const fontFamily = font?.family ?? "sans-serif";

      try {
        const { ctx } = canvas;
        ctx.font = `${fontSize}px "${fontFamily}"`;
        ctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
        ctx.fillText(text, x, y);
        return 0;
      } catch {
        return CanvasError.InvalidFont;
      }
    },

    get_image: (ctxId: number): number => {
      const canvas = getCanvas(ctxId);
      if (!canvas) return CanvasError.InvalidContext;

      try {
        const bitmap = canvas.canvas.transferToImageBitmap();
        const tempCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const tempCtx = tempCanvas.getContext("2d");
        if (!tempCtx) return CanvasError.InvalidResult;
        tempCtx.drawImage(bitmap, 0, 0);
        const imageData = tempCtx.getImageData(0, 0, bitmap.width, bitmap.height);

        const resource: ImageResource = {
          type: "image",
          bitmap,
          data: new Uint8Array(imageData.data),
          width: bitmap.width,
          height: bitmap.height,
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
      const weightMap: Record<number, number> = {
        0: 100,
        1: 200,
        2: 300,
        3: 400,
        4: 500,
        5: 600,
        6: 700,
        7: 800,
        8: 900,
      };
      const cssWeight = weightMap[weight] ?? 400;
      const resource: FontResource = { type: "font", family: `system-ui` };
      return store.storeStdValue({ ...resource, weight: cssWeight });
    },

    load_font: (urlPtr: number, urlLen: number): number => {
      const url = store.readString(urlPtr, urlLen);
      if (!url) return CanvasError.InvalidString;

      try {
        const fontFamily = `loaded-font-${Date.now()}`;
        const fontFace = new FontFace(fontFamily, `url(${url})`);
        fontFace
          .load()
          .then((loaded) => {
            // In browser context, add to document.fonts
            if (typeof document !== "undefined") {
              document.fonts.add(loaded);
            }
          })
          .catch(() => {
            console.warn(`[Canvas] Failed to load font from ${url}`);
          });

        const resource: FontResource = { type: "font", family: fontFamily };
        return store.storeStdValue(resource);
      } catch {
        return CanvasError.FontLoadFailed;
      }
    },

    new_image: (dataPtr: number, dataLen: number): number => {
      const data = store.readBytes(dataPtr, dataLen);
      if (!data) return CanvasError.InvalidImagePointer;

      try {
        const dataCopy = new Uint8Array(data);
        const resource: ImageResource = {
          type: "image",
          bitmap: null,
          data: dataCopy,
          width: 0,
          height: 0,
        };
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
        if (image.bitmap) {
          const canvas = new OffscreenCanvas(image.bitmap.width, image.bitmap.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) return CanvasError.InvalidResult;

          ctx.drawImage(image.bitmap, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const pngBytes = encodeRGBAasPNG(imageData.data, canvas.width, canvas.height);
          return store.storeStdValue(pngBytes);
        }
        return store.storeStdValue(image.data);
      } catch {
        return CanvasError.InvalidResult;
      }
    },

    get_image_width: (imageId: number): number => {
      const image = getImage(imageId);
      if (!image) return 0;
      return image.width;
    },

    get_image_height: (imageId: number): number => {
      const image = getImage(imageId);
      if (!image) return 0;
      return image.height;
    },
  };
}

