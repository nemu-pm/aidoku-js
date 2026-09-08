/**
 * Comlink transfer handlers for runtime errors
 *
 * Comlink's built-in handling of a thrown value keeps only `name`, `message`
 * and `stack`, so a `CloudflareBlockedError` arrives on the other side of the
 * worker boundary as a plain Error with no url or host, and an
 * `AidokuResultError` loses its code. These handlers serialise the fields and
 * rebuild the real error class, so `instanceof` and the extra fields survive.
 *
 * Import this module on both sides of the boundary: registration happens on
 * load and is idempotent.
 */
import * as Comlink from "comlink";
import { CloudflareBlockedError } from "../imports/net";
import { AidokuResultError, AidokuResultErrorCode } from "../result-decoder";

/** Fields shared by every serialised error. */
interface SerializedErrorBase {
  kind: string;
  message: string;
  stack?: string;
}

interface SerializedCloudflareBlockedError extends SerializedErrorBase {
  kind: "CloudflareBlockedError";
  url: string;
  status: number;
  host: string;
  userAgent?: string;
}

interface SerializedAidokuResultError extends SerializedErrorBase {
  kind: "AidokuResultError";
  code: number;
}

export type SerializedRuntimeError =
  | SerializedCloudflareBlockedError
  | SerializedAidokuResultError;

/** Codec for one error class. */
interface ErrorCodec<T extends Error> {
  kind: SerializedRuntimeError["kind"];
  canHandle(value: unknown): value is T;
  serialize(error: T): SerializedRuntimeError;
  deserialize(data: SerializedRuntimeError): T;
}

/** Match by name as well, since an error may have crossed a boundary already. */
function isErrorNamed(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

export const cloudflareBlockedErrorCodec: ErrorCodec<CloudflareBlockedError> = {
  kind: "CloudflareBlockedError",

  canHandle: (value): value is CloudflareBlockedError =>
    value instanceof CloudflareBlockedError ||
    isErrorNamed(value, "CloudflareBlockedError"),

  // Fields are read defensively: an error that already crossed a boundary
  // without these handlers keeps its name but may have lost everything else.
  serialize: (error) => ({
    kind: "CloudflareBlockedError",
    message: error.message,
    stack: error.stack,
    url: error.url ?? "",
    status: error.status ?? 0,
    host: error.host ?? "",
    userAgent: error.userAgent,
  }),

  deserialize: (data) => {
    const serialized = data as SerializedCloudflareBlockedError;
    const error = new CloudflareBlockedError(serialized.url, serialized.status, {
      host: serialized.host,
      userAgent: serialized.userAgent,
    });
    if (serialized.stack) error.stack = serialized.stack;
    return error;
  },
};

export const aidokuResultErrorCodec: ErrorCodec<AidokuResultError> = {
  kind: "AidokuResultError",

  canHandle: (value): value is AidokuResultError =>
    value instanceof AidokuResultError || isErrorNamed(value, "AidokuResultError"),

  serialize: (error) => ({
    kind: "AidokuResultError",
    message: error.message,
    stack: error.stack,
    code: typeof error.code === "number" ? error.code : AidokuResultErrorCode.Message,
  }),

  deserialize: (data) => {
    const serialized = data as SerializedAidokuResultError;
    const error = new AidokuResultError(serialized.code, serialized.message);
    if (serialized.stack) error.stack = serialized.stack;
    return error;
  },
};

/** Codec with its error type erased, so codecs can share one list. */
interface AnyErrorCodec {
  kind: SerializedRuntimeError["kind"];
  canHandle(value: unknown): boolean;
  serialize(error: Error): SerializedRuntimeError;
  deserialize(data: SerializedRuntimeError): Error;
}

const ERROR_CODECS: AnyErrorCodec[] = [
  cloudflareBlockedErrorCodec as AnyErrorCodec,
  aidokuResultErrorCodec as AnyErrorCodec,
];

/** Serialise a runtime error, or null if no codec claims it. */
export function serializeRuntimeError(value: unknown): SerializedRuntimeError | null {
  for (const codec of ERROR_CODECS) {
    if (codec.canHandle(value)) {
      return codec.serialize(value as Error);
    }
  }
  return null;
}

/** Rebuild a runtime error from its serialised form. */
export function deserializeRuntimeError(data: SerializedRuntimeError): Error {
  const codec = ERROR_CODECS.find((candidate) => candidate.kind === data.kind);
  if (!codec) {
    return Object.assign(new Error(data.message), { name: data.kind });
  }
  return codec.deserialize(data);
}

/**
 * Wire form of a thrown value.
 *
 * `isError`/`value.message`/`value.name` mirror Comlink's own shape, so a peer
 * that has not registered these handlers still gets a usable Error, just
 * without the class identity.
 */
interface SerializedThrow {
  isError: boolean;
  value?: {
    message: string;
    name: string;
    stack?: string;
    runtimeError?: SerializedRuntimeError;
  };
  rawValue?: unknown;
}

/** Comlink wraps a thrown value under a private symbol keyed "Comlink.thrown". */
function isThrownWrapper(value: unknown): value is { value: unknown } {
  if (typeof value !== "object" || value === null) return false;
  return Object.getOwnPropertySymbols(value).some(
    (symbol) => symbol.description === "Comlink.thrown"
  );
}

/**
 * Replacement for Comlink's "throw" handler that keeps runtime error classes.
 * Registered under the same key so it keeps the built-in handler's position in
 * the lookup order, which is what lets it see thrown values at all.
 */
export const runtimeErrorThrowHandler: Comlink.TransferHandler<
  { value: unknown },
  SerializedThrow
> = {
  canHandle: isThrownWrapper,

  serialize: ({ value }) => {
    if (value instanceof Error) {
      const runtimeError = serializeRuntimeError(value);
      return [
        {
          isError: true,
          value: {
            message: value.message,
            name: value.name,
            stack: value.stack,
            ...(runtimeError ? { runtimeError } : {}),
          },
        },
        [],
      ];
    }
    return [{ isError: false, rawValue: value }, []];
  },

  deserialize: (serialized) => {
    if (!serialized.isError) {
      throw serialized.rawValue;
    }
    const details = serialized.value!;
    if (details.runtimeError) {
      throw deserializeRuntimeError(details.runtimeError);
    }
    throw Object.assign(new Error(details.message), {
      name: details.name,
      stack: details.stack,
    });
  },
};

let registered = false;

/** Register the handlers with Comlink. Safe to call more than once. */
export function registerErrorTransferHandlers(): void {
  if (registered) return;
  registered = true;

  // Replaces the built-in handler; Map.set keeps the existing key's position.
  Comlink.transferHandlers.set(
    "throw",
    runtimeErrorThrowHandler as unknown as Comlink.TransferHandler<unknown, unknown>
  );

  // Errors passed as plain values (not thrown) round-trip through these.
  for (const codec of ERROR_CODECS) {
    Comlink.transferHandlers.set(codec.kind, {
      canHandle: codec.canHandle,
      serialize: (error: Error) => [codec.serialize(error), []],
      deserialize: (data: SerializedRuntimeError) => deserializeRuntimeError(data),
    } as unknown as Comlink.TransferHandler<unknown, unknown>);
  }
}

registerErrorTransferHandlers();
