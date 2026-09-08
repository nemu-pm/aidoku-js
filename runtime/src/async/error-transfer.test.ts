import { describe, expect, it } from "bun:test";
import * as Comlink from "comlink";
import { CloudflareBlockedError } from "../imports/net";
import { AidokuResultError, AidokuResultErrorCode } from "../result-decoder";
import {
  aidokuResultErrorCodec,
  cloudflareBlockedErrorCodec,
  deserializeRuntimeError,
  runtimeErrorThrowHandler,
  serializeRuntimeError,
  type SerializedRuntimeError,
} from "./error-transfer";

/** Stand-in for the wrapper Comlink puts around a thrown value. */
function thrownWrapper(value: unknown): { value: unknown } {
  return { value, [Symbol("Comlink.thrown")]: 0 } as { value: unknown };
}

/** Serialise and deserialise the way a postMessage round trip would. */
function roundTripThrow(value: unknown): unknown {
  const [serialized] = runtimeErrorThrowHandler.serialize(thrownWrapper(value));
  const wire = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
  try {
    runtimeErrorThrowHandler.deserialize(wire);
  } catch (e) {
    return e;
  }
  throw new Error("the throw handler must rethrow");
}

describe("error transfer handlers", () => {
  it("registers with Comlink under the built-in throw key", () => {
    expect(Comlink.transferHandlers.get("throw")).toBe(
      runtimeErrorThrowHandler as unknown as Comlink.TransferHandler<unknown, unknown>
    );
    expect(Comlink.transferHandlers.has("CloudflareBlockedError")).toBe(true);
    expect(Comlink.transferHandlers.has("AidokuResultError")).toBe(true);
  });

  describe("CloudflareBlockedError", () => {
    const error = new CloudflareBlockedError("https://example.com/manga/1", 403, {
      userAgent: "Aidoku/1",
    });

    it("round-trips every field through its codec", () => {
      const serialized = cloudflareBlockedErrorCodec.serialize(error);
      const restored = cloudflareBlockedErrorCodec.deserialize(
        JSON.parse(JSON.stringify(serialized)) as SerializedRuntimeError
      );

      expect(restored).toBeInstanceOf(CloudflareBlockedError);
      expect(restored.name).toBe("CloudflareBlockedError");
      expect(restored.message).toBe(error.message);
      expect(restored.url).toBe("https://example.com/manga/1");
      expect(restored.status).toBe(403);
      expect(restored.host).toBe("example.com");
      expect(restored.userAgent).toBe("Aidoku/1");
      expect(restored.challengeInfo).toEqual(error.challengeInfo);
    });

    it("survives the throw path", () => {
      const restored = roundTripThrow(error);

      expect(restored).toBeInstanceOf(CloudflareBlockedError);
      const cfError = restored as CloudflareBlockedError;
      expect(cfError.url).toBe("https://example.com/manga/1");
      expect(cfError.host).toBe("example.com");
      expect(cfError.userAgent).toBe("Aidoku/1");
      expect(cfError.status).toBe(403);
    });

    it("keeps a missing User-Agent optional", () => {
      const plain = new CloudflareBlockedError("https://example.com/a", 503);
      const restored = roundTripThrow(plain) as CloudflareBlockedError;

      expect(restored.userAgent).toBeUndefined();
      expect(restored.host).toBe("example.com");
    });
  });

  describe("AidokuResultError", () => {
    const error = new AidokuResultError(
      AidokuResultErrorCode.Message,
      "chapter is premium"
    );

    it("round-trips the code through its codec", () => {
      const serialized = aidokuResultErrorCodec.serialize(error);
      const restored = aidokuResultErrorCodec.deserialize(
        JSON.parse(JSON.stringify(serialized)) as SerializedRuntimeError
      );

      expect(restored).toBeInstanceOf(AidokuResultError);
      expect(restored.name).toBe("AidokuResultError");
      expect(restored.code).toBe(-1);
      expect(restored.message).toBe("chapter is premium");
    });

    it("survives the throw path", () => {
      const restored = roundTripThrow(new AidokuResultError(-2));

      expect(restored).toBeInstanceOf(AidokuResultError);
      expect((restored as AidokuResultError).code).toBe(-2);
      expect((restored as AidokuResultError).message).toBe("Unimplemented");
    });
  });

  describe("throw handler", () => {
    it("only claims Comlink's thrown wrapper", () => {
      expect(runtimeErrorThrowHandler.canHandle(thrownWrapper(new Error("x")))).toBe(true);
      expect(runtimeErrorThrowHandler.canHandle({ value: new Error("x") })).toBe(false);
      expect(runtimeErrorThrowHandler.canHandle(new Error("x"))).toBe(false);
      expect(runtimeErrorThrowHandler.canHandle(null)).toBe(false);
      expect(runtimeErrorThrowHandler.canHandle("boom")).toBe(false);
    });

    it("keeps name and message for other errors", () => {
      const restored = roundTripThrow(new TypeError("wasm trap")) as Error;

      expect(restored).toBeInstanceOf(Error);
      expect(restored.name).toBe("TypeError");
      expect(restored.message).toBe("wasm trap");
    });

    it("passes non-error thrown values through", () => {
      expect(roundTripThrow("boom")).toBe("boom");
      expect(roundTripThrow({ code: 7 })).toEqual({ code: 7 });
    });

    it("stays readable for a peer without these handlers", () => {
      // Comlink's built-in deserialize reads isError and value.message/name
      const [serialized] = runtimeErrorThrowHandler.serialize(
        thrownWrapper(new CloudflareBlockedError("https://example.com/a", 403))
      );

      expect(serialized.isError).toBe(true);
      expect(serialized.value?.name).toBe("CloudflareBlockedError");
      expect(serialized.value?.message).toContain("https://example.com/a");
    });
  });

  describe("over a real Comlink endpoint", () => {
    /** Expose `boom` on one port and proxy it from the other. */
    async function throwAcrossChannel(error: Error): Promise<unknown> {
      const channel = new MessageChannel();
      Comlink.expose(
        {
          boom() {
            throw error;
          },
        },
        channel.port1
      );
      const proxy = Comlink.wrap<{ boom(): Promise<void> }>(channel.port2);

      try {
        await proxy.boom();
        throw new Error("expected the call to reject");
      } catch (e) {
        return e;
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    }

    it("delivers a challenge error with its fields intact", async () => {
      const received = await throwAcrossChannel(
        new CloudflareBlockedError("https://example.com/manga/1", 403, {
          userAgent: "Aidoku/1",
        })
      );

      expect(received).toBeInstanceOf(CloudflareBlockedError);
      const cfError = received as CloudflareBlockedError;
      expect(cfError.name).toBe("CloudflareBlockedError");
      expect(cfError.url).toBe("https://example.com/manga/1");
      expect(cfError.status).toBe(403);
      expect(cfError.host).toBe("example.com");
      expect(cfError.userAgent).toBe("Aidoku/1");
    });

    it("delivers a source error with its code intact", async () => {
      const received = await throwAcrossChannel(
        new AidokuResultError(AidokuResultErrorCode.Message, "chapter is premium")
      );

      expect(received).toBeInstanceOf(AidokuResultError);
      expect((received as AidokuResultError).code).toBe(-1);
      expect((received as AidokuResultError).message).toBe("chapter is premium");
    });

    it("still delivers unrelated errors", async () => {
      const received = (await throwAcrossChannel(new TypeError("wasm trap"))) as Error;

      expect(received.message).toBe("wasm trap");
      expect(received.name).toBe("TypeError");
    });
  });

  describe("serializeRuntimeError", () => {
    it("ignores errors it has no codec for", () => {
      expect(serializeRuntimeError(new Error("plain"))).toBeNull();
      expect(serializeRuntimeError("not an error")).toBeNull();
    });

    it("recognises an error that already crossed a boundary by name", () => {
      const degraded = Object.assign(new Error("stale"), {
        name: "AidokuResultError",
        code: -3,
      });

      expect(serializeRuntimeError(degraded)).toEqual({
        kind: "AidokuResultError",
        message: "stale",
        stack: degraded.stack,
        code: -3,
      });
    });

    it("fills in defaults for a degraded challenge error", () => {
      const degraded = Object.assign(new Error("stale challenge"), {
        name: "CloudflareBlockedError",
      });

      expect(serializeRuntimeError(degraded)).toEqual({
        kind: "CloudflareBlockedError",
        message: "stale challenge",
        stack: degraded.stack,
        url: "",
        status: 0,
        host: "",
        userAgent: undefined,
      });
    });

    it("falls back to a plain error for an unknown kind", () => {
      const restored = deserializeRuntimeError({
        kind: "SomethingElse",
        message: "unknown",
      } as unknown as SerializedRuntimeError);

      expect(restored).toBeInstanceOf(Error);
      expect(restored.name).toBe("SomethingElse");
      expect(restored.message).toBe("unknown");
    });
  });
});
