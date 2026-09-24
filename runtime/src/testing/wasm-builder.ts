/**
 * Tiny WebAssembly module builder for runtime tests.
 *
 * Every parameter and result is an i32. Functions can import from the host
 * (`net.send`, `defaults.set`, ...), so a test can drive the real import object
 * the runtime builds instead of stubbing it. Not part of the published build.
 */

export interface WasmImportSpec {
  module: string;
  name: string;
  params: number;
  results: 0 | 1;
}

export interface WasmFunctionSpec {
  /** Export name */
  name: string;
  params: number;
  results: 0 | 1;
  /** Extra i32 locals, indexed after the parameters */
  locals?: number;
  /** Instructions, without the trailing `end` */
  body: number[];
}

export interface WasmDataSpec {
  offset: number;
  bytes: ArrayLike<number>;
}

export interface WasmModuleSpec {
  imports?: WasmImportSpec[];
  functions: WasmFunctionSpec[];
  data?: WasmDataSpec[];
}

function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done =
      (value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

function name(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

function vector(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

/** Instruction helpers */
export const op = {
  i32Const: (value: number) => [0x41, ...sleb(value)],
  call: (functionIndex: number) => [0x10, ...uleb(functionIndex)],
  localGet: (index: number) => [0x20, ...uleb(index)],
  localSet: (index: number) => [0x21, ...uleb(index)],
  drop: () => [0x1a],
};

/** Frame a result payload the way aidoku-rs does: [i32 len][i32 cap][payload]. */
export function framedResult(payload: ArrayLike<number>): number[] {
  const len = payload.length + 8;
  const i32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
  return [...i32(len), ...i32(len), ...Array.from(payload)];
}

export function buildWasm(spec: WasmModuleSpec): Uint8Array {
  const imports = spec.imports ?? [];
  const functions = spec.functions;

  const signatures: string[] = [];
  const typeIndex = (params: number, results: 0 | 1) => {
    const key = `${params}:${results}`;
    let index = signatures.indexOf(key);
    if (index < 0) {
      index = signatures.length;
      signatures.push(key);
    }
    return index;
  };
  const importTypes = imports.map((entry) => typeIndex(entry.params, entry.results));
  const functionTypes = functions.map((fn) => typeIndex(fn.params, fn.results));

  const types = section(
    1,
    vector(
      signatures.map((key) => {
        const [params, results] = key.split(":").map(Number);
        return [0x60, ...uleb(params), ...new Array(params).fill(0x7f), ...uleb(results), ...new Array(results).fill(0x7f)];
      })
    )
  );
  const importSection = imports.length
    ? section(
        2,
        vector(imports.map((entry, i) => [...name(entry.module), ...name(entry.name), 0x00, ...uleb(importTypes[i])]))
      )
    : [];
  const functionSection = section(3, vector(functionTypes.map((t) => uleb(t))));
  const memory = section(5, [0x01, 0x00, 0x01]);
  const exportSection = section(
    7,
    vector([
      [...name("memory"), 0x02, 0x00],
      ...functions.map((fn, i) => [...name(fn.name), 0x00, ...uleb(imports.length + i)]),
    ])
  );
  const code = section(
    10,
    vector(
      functions.map((fn) => {
        const locals = fn.locals ? [0x01, ...uleb(fn.locals), 0x7f] : [0x00];
        const body = [...locals, ...fn.body, 0x0b];
        return [...uleb(body.length), ...body];
      })
    )
  );
  const dataSection = spec.data?.length
    ? section(
        11,
        vector(
          spec.data.map((segment) => [
            0x00,
            ...op.i32Const(segment.offset),
            0x0b,
            ...uleb(segment.bytes.length),
            ...Array.from(segment.bytes),
          ])
        )
      )
    : [];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...types,
    ...importSection,
    ...functionSection,
    ...memory,
    ...exportSection,
    ...code,
    ...dataSection,
  ]);
}
