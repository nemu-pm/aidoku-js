import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import { createHtmlImports } from "./html";

const NodeKind = {
  TextNode: 2,
  Comment: 4,
  Element: 5,
  ElementList: 6,
  Document: 7,
} as const;

describe("html imports", () => {
  let store: GlobalStore | null = null;

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  function parse(html: string): { imports: ReturnType<typeof createHtmlImports>; doc: number } {
    store = new GlobalStore("test.source");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createHtmlImports(store);
    store.writeString(html, 8);
    const doc = imports.parse(8, html.length, 0, 0);
    expect(doc).toBeGreaterThanOrEqual(0);
    return { imports, doc };
  }

  it("child_nodes includes text and comment nodes", () => {
    const { imports, doc } = parse("<div><span>a</span>text<!--c--></div>");
    store!.writeString("div", 256);
    const div = imports.select_first(doc, 256, 3);
    expect(div).toBeGreaterThanOrEqual(0);

    const nodes = imports.child_nodes(div);
    expect(nodes).toBeGreaterThanOrEqual(0);
    expect(imports.size(nodes)).toBe(3);

    expect(imports.kind(imports.get(nodes, 0))).toBe(NodeKind.Element);
    expect(imports.kind(imports.get(nodes, 1))).toBe(NodeKind.TextNode);
    expect(imports.kind(imports.get(nodes, 2))).toBe(NodeKind.Comment);
  });

  it("kind distinguishes documents and element lists", () => {
    const { imports, doc } = parse("<p>one</p><p>two</p>");
    expect(imports.kind(doc)).toBe(NodeKind.Document);

    store!.writeString("p", 256);
    const list = imports.select(doc, 256, 1);
    expect(imports.kind(list)).toBe(NodeKind.ElementList);
  });

  it("remove detaches a node from the document", () => {
    const { imports, doc } = parse("<div><span class='ad'>x</span><p>keep</p></div>");
    store!.writeString("span.ad", 256);
    const ad = imports.select_first(doc, 256, 7);
    expect(ad).toBeGreaterThanOrEqual(0);
    expect(imports.remove(ad)).toBe(0);

    store!.writeString("span.ad", 256);
    const gone = imports.select(doc, 256, 7);
    expect(imports.size(gone)).toBe(0);
  });
});
