import { describe, expect, it } from "bun:test";
import { extractSettingsDefaults } from "./common";

// Mirrors SETTING_DEFAULT_LIMITS in common.ts
const MAX_DEPTH = 32;
const MAX_NODES = 1024;
const MAX_LIST_ITEMS = 256;
const MAX_KEY_LENGTH = 256;
const MAX_STRING_LENGTH = 4096;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000_000;

function nestedSchema(groupCount: number, key: string): unknown[] {
  const root: unknown[] = [];
  let items = root;
  for (let index = 0; index < groupCount; index += 1) {
    const children: unknown[] = [];
    items.push({ type: "group", items: children });
    items = children;
  }
  items.push({ type: "text", key, default: "kept" });
  return root;
}

describe("extractSettingsDefaults", () => {
  it("reads top-level, group and page defaults", () => {
    expect(
      extractSettingsDefaults([
        { type: "switch", key: "nsfw", default: false },
        {
          type: "group",
          items: [
            { type: "select", key: "quality", default: "high" },
            { type: "page", items: [{ type: "text", key: "server", default: "a" }] },
          ],
        },
        { type: "button", key: "login", title: "Log in" },
      ])
    ).toEqual({ nsfw: false, quality: "high", server: "a" });
  });

  it("accepts only bounded type-compatible default shapes", () => {
    const defaults = extractSettingsDefaults([
      { type: "text", key: "text", default: "reader" },
      { type: "select", key: "select", default: "en" },
      { type: "picker", key: "picker", default: "webtoon" },
      { type: "picker", key: "wrong-picker", default: 2 },
      { type: "switch", key: "enabled", default: true },
      { type: "stepper", key: "count", minimumValue: 5, maximumValue: 50, default: 500 },
      { type: "slider", key: "zoom", min: 2, max: 1, default: 0 },
      { type: "segment", key: "quality", default: 1 },
      { type: "multi-select", key: "languages", default: ["en", "ja"] },
      { type: "multi-single-select", key: "single-language", default: ["en", "ja"] },
      { type: "editable-list", key: "hosts", default: ["example.test"] },
      { type: "switch", key: "wrong-switch", default: "yes" },
      { type: "segment", key: "wrong-segment", default: 1.5 },
      { type: "multi-select", key: "wrong-list", default: ["en", 1] },
      { type: "text", key: "huge-string", default: "x".repeat(MAX_STRING_LENGTH + 1) },
      {
        type: "multi-select",
        key: "huge-list",
        default: new Array(MAX_LIST_ITEMS + 1).fill("x"),
      },
      { type: "slider", key: "huge-number", default: MAX_ABSOLUTE_NUMBER + 1 },
      { type: "text", key: "x".repeat(MAX_KEY_LENGTH + 1), default: "bad key" },
      { type: "text", key: "   ", default: "blank key" },
      { type: "unknown", key: "unknown", default: "drop" },
      { type: "text", key: "text", default: "second occurrence" },
    ]);

    expect(defaults).toEqual({
      text: "reader",
      select: "en",
      picker: "webtoon",
      enabled: true,
      count: 50,
      zoom: 1,
      quality: 1,
      languages: ["en", "ja"],
      "single-language": ["en"],
      hosts: ["example.test"],
    });
    expect(Object.getPrototypeOf(defaults)).toBeNull();
  });

  it("fails closed for non-array roots, revoked proxies, and accessors", () => {
    for (const input of [null, undefined, {}, "settings", 1]) {
      const defaults = extractSettingsDefaults(input);
      expect(Object.keys(defaults)).toEqual([]);
      expect(Object.getPrototypeOf(defaults)).toBeNull();
    }

    let getterCalls = 0;
    const rootAccessor: unknown[] = [];
    Object.defineProperty(rootAccessor, "0", {
      get() {
        getterCalls += 1;
        return { type: "text", key: "root-accessor", default: "bad" };
      },
    });
    rootAccessor.length = 1;

    const nodeAccessor: Record<string, unknown> = { type: "text" };
    Object.defineProperty(nodeAccessor, "key", {
      get() {
        getterCalls += 1;
        return "node-accessor";
      },
    });
    Object.defineProperty(nodeAccessor, "default", {
      get() {
        getterCalls += 1;
        return "bad";
      },
    });

    const arrayDefault: string[] = [];
    Object.defineProperty(arrayDefault, "0", {
      get() {
        getterCalls += 1;
        return "bad";
      },
    });
    arrayDefault.length = 1;

    expect(extractSettingsDefaults(rootAccessor)).toEqual({});
    expect(
      extractSettingsDefaults([
        nodeAccessor,
        { type: "multi-select", key: "array-accessor", default: arrayDefault },
      ])
    ).toEqual({});
    expect(getterCalls).toBe(0);

    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(() => extractSettingsDefaults(proxy)).not.toThrow();
    expect(extractSettingsDefaults(proxy)).toEqual({});
  });

  it("bounds depth, candidate entries, and cyclic containers", () => {
    expect(extractSettingsDefaults(nestedSchema(MAX_DEPTH, "at-depth-limit"))).toEqual({
      "at-depth-limit": "kept",
    });
    expect(extractSettingsDefaults(nestedSchema(MAX_DEPTH + 1, "past-depth-limit"))).toEqual({});

    const cyclicRoot: unknown[] = [{ type: "text", key: "first", default: "kept" }];
    cyclicRoot.push({ type: "group", items: cyclicRoot });
    expect(extractSettingsDefaults(cyclicRoot)).toEqual({ first: "kept" });

    const wide = Array.from({ length: MAX_NODES + 1 }, (_, index) => ({
      type: "text",
      key: `setting-${index}`,
      default: `value-${index}`,
    }));
    const defaults = extractSettingsDefaults(wide);
    expect(Object.keys(defaults)).toHaveLength(MAX_NODES);
    expect(defaults["setting-0"]).toBe("value-0");
    expect(defaults[`setting-${MAX_NODES - 1}`]).toBe(`value-${MAX_NODES - 1}`);
    expect(defaults[`setting-${MAX_NODES}`]).toBeUndefined();
  });

  it("stops once the schema string budget is spent", () => {
    // 300 * 4096 characters exceeds the 1 MiB budget
    const schema = Array.from({ length: 300 }, (_, index) => ({
      type: "text",
      key: `k${index}`,
      default: "x".repeat(MAX_STRING_LENGTH),
    }));
    const keys = Object.keys(extractSettingsDefaults(schema));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(300);
  });

  it("defines prototype-looking keys without mutating any prototype", () => {
    const protoSetting = JSON.parse(
      '{"type":"text","key":"__proto__","default":"safe-own-value"}'
    ) as unknown;
    const defaults = extractSettingsDefaults([
      protoSetting,
      { type: "text", key: "constructor", default: "safe-constructor" },
      { type: "text", key: "toString", default: "safe-to-string" },
      { type: "text", key: "bad‮key", default: "drop" },
    ]);

    expect(Object.getPrototypeOf(defaults)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(defaults, "__proto__")).toBe(true);
    expect(defaults["__proto__"]).toBe("safe-own-value");
    const spread = { ...defaults };
    expect(Object.getPrototypeOf(spread)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(spread, "__proto__")).toBe(true);

    const rejectedObjectPayload = extractSettingsDefaults([
      JSON.parse('{"type":"text","key":"__proto__","default":{"polluted":true}}'),
    ]);
    expect(Object.prototype.hasOwnProperty.call(rejectedObjectPayload, "__proto__")).toBe(false);
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
    expect(defaults["bad‮key"]).toBeUndefined();
  });
});
