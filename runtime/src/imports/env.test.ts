import { afterEach, describe, expect, it } from "bun:test";
import { GlobalStore } from "../global-store";
import { createEnvImports } from "./env";

describe("env.sleep", () => {
  let store: GlobalStore | null = null;

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("hands the sleep to the host clock", () => {
    store = new GlobalStore("sleep");
    const slept: number[] = [];
    const imports = createEnvImports(store, { sleep: (seconds) => slept.push(seconds) });

    const start = Date.now();
    imports.sleep(5);
    expect(slept).toEqual([5]);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("busy-waits on real time when the host clock only pins now", () => {
    store = new GlobalStore("sleep");
    const imports = createEnvImports(store, { now: () => 0 });

    const start = performance.now();
    imports.sleep(0.02);
    expect(performance.now() - start).toBeGreaterThanOrEqual(19);
  });
});
