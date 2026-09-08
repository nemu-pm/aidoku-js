import { describe, it, expect } from "bun:test";
import {
  readResultPayload,
  decodeZigzagVarint,
  decodeRidFromPayload,
  isResultError,
  getResultErrorMessage,
  createResultError,
  readResultErrorMessage,
  readResultOrThrow,
  AidokuResultError,
  AidokuResultErrorCode,
  RuntimeMode,
  detectRuntimeMode,
} from "./result-decoder";

describe("result-decoder", () => {
  describe("decodeZigzagVarint", () => {
    it("should decode positive integers", () => {
      // 1 -> zigzag 2 -> 0x02
      const [value, bytesRead] = decodeZigzagVarint(new Uint8Array([0x02]), 0);
      expect(value).toBe(1);
      expect(bytesRead).toBe(1);
    });

    it("should decode negative integers", () => {
      // -1 -> zigzag 1 -> 0x01
      const [value, bytesRead] = decodeZigzagVarint(new Uint8Array([0x01]), 0);
      expect(value).toBe(-1);
      expect(bytesRead).toBe(1);
    });

    it("should decode zero", () => {
      const [value, bytesRead] = decodeZigzagVarint(new Uint8Array([0x00]), 0);
      expect(value).toBe(0);
      expect(bytesRead).toBe(1);
    });

    it("should decode larger positive numbers", () => {
      // 100 -> zigzag 200 -> 0xc8 0x01
      const [value, bytesRead] = decodeZigzagVarint(new Uint8Array([0xc8, 0x01]), 0);
      expect(value).toBe(100);
      expect(bytesRead).toBe(2);
    });

    it("should decode larger negative numbers", () => {
      // -100 -> zigzag 199 -> 0xc7 0x01
      const [value, bytesRead] = decodeZigzagVarint(new Uint8Array([0xc7, 0x01]), 0);
      expect(value).toBe(-100);
      expect(bytesRead).toBe(2);
    });

    it("should respect offset", () => {
      const bytes = new Uint8Array([0xff, 0xff, 0x02, 0x00]);
      const [value, bytesRead] = decodeZigzagVarint(bytes, 2);
      expect(value).toBe(1);
      expect(bytesRead).toBe(1);
    });
  });

  describe("readResultPayload", () => {
    it("should return null for invalid pointer", () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      expect(readResultPayload(memory, -1)).toBeNull();
      expect(readResultPayload(memory, 0)).toBeNull();
    });

    it("should return null for too small length", () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const view = new DataView(memory.buffer);
      // Write len = 8 (just header, no payload)
      view.setInt32(100, 8, true);
      expect(readResultPayload(memory, 100)).toBeNull();
    });

    it("should read payload correctly", () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const view = new DataView(memory.buffer);
      const view8 = new Uint8Array(memory.buffer);
      
      // Write result at offset 100
      // len = 12 (8 header + 4 payload)
      view.setInt32(100, 12, true);
      // cap = 12
      view.setInt32(104, 12, true);
      // payload: [0x01, 0x02, 0x03, 0x04]
      view8.set([0x01, 0x02, 0x03, 0x04], 108);
      
      const payload = readResultPayload(memory, 100);
      expect(payload).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    });
  });

  describe("decodeRidFromPayload", () => {
    it("should return null for empty payload", () => {
      expect(decodeRidFromPayload(new Uint8Array([]))).toBeNull();
    });

    it("should decode positive RID", () => {
      // RID 42 -> zigzag 84 -> 0x54
      expect(decodeRidFromPayload(new Uint8Array([0x54]))).toBe(42);
    });

    it("should decode zero RID", () => {
      expect(decodeRidFromPayload(new Uint8Array([0x00]))).toBe(0);
    });

    it("should decode negative RID (error case)", () => {
      // -1 -> zigzag 1 -> 0x01
      expect(decodeRidFromPayload(new Uint8Array([0x01]))).toBe(-1);
    });
  });

  describe("isResultError", () => {
    it("should identify negative pointers as errors", () => {
      expect(isResultError(-1)).toBe(true);
      expect(isResultError(-2)).toBe(true);
      expect(isResultError(-3)).toBe(true);
    });

    it("should identify non-negative pointers as success", () => {
      expect(isResultError(0)).toBe(false);
      expect(isResultError(1)).toBe(false);
      expect(isResultError(100)).toBe(false);
    });
  });

  describe("getResultErrorMessage", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });

    it("returns null for successful results", () => {
      expect(getResultErrorMessage(memory, 0)).toBeNull();
      expect(getResultErrorMessage(memory, 128)).toBeNull();
    });

    it("describes every error code a source can return", () => {
      expect(getResultErrorMessage(memory, -1)).toBe("Source error");
      expect(getResultErrorMessage(memory, -2)).toBe("Unimplemented");
      expect(getResultErrorMessage(memory, -3)).toBe("Request error");
      expect(getResultErrorMessage(memory, -4)).toBe("HTML parse error");
      expect(getResultErrorMessage(memory, -5)).toBe("JavaScript error");
      expect(getResultErrorMessage(memory, -6)).toBe("Canvas error");
      expect(getResultErrorMessage(memory, -7)).toBe("UTF-8 decode error");
      expect(getResultErrorMessage(memory, -8)).toBe("JSON parse error");
      expect(getResultErrorMessage(memory, -9)).toBe("Deserialize error");
    });

    it("falls back to the raw code for unknown errors", () => {
      expect(getResultErrorMessage(memory, -42)).toBe("Error code: -42");
    });
  });

  describe("AidokuResultErrorCode", () => {
    it("maps each variant to its wire code", () => {
      expect(AidokuResultErrorCode).toEqual({
        Message: -1,
        Unimplemented: -2,
        RequestError: -3,
        HtmlError: -4,
        JsError: -5,
        CanvasError: -6,
        Utf8Error: -7,
        JsonParseError: -8,
        DeserializeError: -9,
      });
    });
  });

  describe("createResultError", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });

    it("carries the numeric code alongside the message", () => {
      const error = createResultError(memory, AidokuResultErrorCode.Unimplemented);

      expect(error).toBeInstanceOf(AidokuResultError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(-2);
      expect(error.name).toBe("AidokuResultError");
      expect(error.message).toBe("Unimplemented");
    });

    it("lets callers tell request failures from unimplemented functions", () => {
      const requestError = createResultError(memory, AidokuResultErrorCode.RequestError);

      expect(requestError.code).toBe(AidokuResultErrorCode.RequestError);
      expect(requestError.code).not.toBe(AidokuResultErrorCode.Unimplemented);
    });

    it("keeps unknown codes intact", () => {
      const error = createResultError(memory, -42);

      expect(error.code).toBe(-42);
      expect(error.message).toBe("Error code: -42");
    });
  });

  describe("readResultErrorMessage", () => {
    /** Write a Message error buffer: [-1][cap][total_len][utf8 message]. */
    function writeMessageError(
      memory: WebAssembly.Memory,
      ptr: number,
      message: string
    ): void {
      const view = new DataView(memory.buffer);
      const bytes = new TextEncoder().encode(message);
      const totalLen = 12 + bytes.length;
      view.setInt32(ptr, -1, true);
      view.setInt32(ptr + 4, totalLen, true);
      view.setInt32(ptr + 8, totalLen, true);
      new Uint8Array(memory.buffer).set(bytes, ptr + 12);
    }

    it("reads the message text after the 12-byte header", () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      writeMessageError(memory, 256, "chapter is premium");

      expect(readResultErrorMessage(memory, 256)).toBe("chapter is premium");
    });

    it("reads multi-byte characters", () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      writeMessageError(memory, 256, "章节需要登录");

      expect(readResultErrorMessage(memory, 256)).toBe("章节需要登录");
    });

    it("returns an empty string when the buffer holds no text", () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      writeMessageError(memory, 256, "");

      expect(readResultErrorMessage(memory, 256)).toBe("");
    });

    it("returns null for successful results and invalid pointers", () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const view = new DataView(memory.buffer);
      // A successful result stores its length where the marker would be
      view.setInt32(256, 12, true);

      expect(readResultErrorMessage(memory, 256)).toBeNull();
      expect(readResultErrorMessage(memory, 0)).toBeNull();
      expect(readResultErrorMessage(memory, -3)).toBeNull();
    });

    describe("readResultOrThrow", () => {
      it("returns the payload of a successful result", () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        const view = new DataView(memory.buffer);
        view.setInt32(256, 12, true);
        view.setInt32(260, 12, true);
        new Uint8Array(memory.buffer).set([0x01, 0x02, 0x03, 0x04], 264);

        expect(readResultOrThrow(memory, 256)).toEqual(
          new Uint8Array([0x01, 0x02, 0x03, 0x04])
        );
      });

      it("throws the source message and frees the buffer", () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        writeMessageError(memory, 256, "chapter is premium");
        const freed: number[] = [];

        try {
          readResultOrThrow(memory, 256, (ptr) => freed.push(ptr));
          throw new Error("expected a source error");
        } catch (e) {
          expect(e).toBeInstanceOf(AidokuResultError);
          expect((e as AidokuResultError).code).toBe(AidokuResultErrorCode.Message);
          expect((e as AidokuResultError).message).toBe("chapter is premium");
        }

        expect(freed).toEqual([256]);
      });

      it("falls back to a generic message for an empty message", () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        writeMessageError(memory, 256, "");

        expect(() => readResultOrThrow(memory, 256)).toThrow("Source error");
      });

      it("throws the numeric code for a negative result", () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        const freed: number[] = [];

        try {
          readResultOrThrow(memory, -4, (ptr) => freed.push(ptr));
          throw new Error("expected a source error");
        } catch (e) {
          expect((e as AidokuResultError).code).toBe(-4);
          expect((e as AidokuResultError).message).toBe("HTML parse error");
        }

        // Nothing was allocated, so nothing is freed
        expect(freed).toEqual([]);
      });
    });
  });

  describe("detectRuntimeMode", () => {
    it("should detect aidoku-rs mode with new exports", () => {
      const exports = {
        start: () => {},
        get_search_manga_list: () => 0,
        get_manga_update: () => 0,
        get_page_list: () => 0,
      };
      expect(detectRuntimeMode(exports)).toBe(RuntimeMode.AidokuRs);
    });

    it("should detect legacy mode with old exports", () => {
      const exports = {
        get_manga_list: () => 0,
        get_manga_details: () => 0,
        get_chapter_list: () => 0,
        get_page_list: () => 0,
      };
      expect(detectRuntimeMode(exports)).toBe(RuntimeMode.Legacy);
    });

    it("should prefer aidoku-rs when both ABIs present", () => {
      const exports = {
        get_search_manga_list: () => 0, // New ABI
        get_manga_details: () => 0, // Old ABI
      };
      expect(detectRuntimeMode(exports)).toBe(RuntimeMode.AidokuRs);
    });

    it("should default to aidoku-rs for unknown exports", () => {
      const exports = {
        custom_function: () => {},
      };
      expect(detectRuntimeMode(exports)).toBe(RuntimeMode.AidokuRs);
    });
  });
});

