import { describe, expect, it, afterEach } from "bun:test";
import { GlobalStore } from "../global-store";
import { load } from "cheerio";
import { createHtmlImports, resolveUrl } from "./html";

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
  /** Write strings at fixed offsets and return their [ptr, len] pairs. */
  function strings(...values: string[]): [number, number][] {
    return values.map((value, i) => {
      const ptr = 512 + i * 128;
      store!.writeString(value, ptr);
      return [ptr, new TextEncoder().encode(value).length];
    });
  }

  function outerHtml(imports: ReturnType<typeof createHtmlImports>, rid: number): string {
    return store!.readStdValue(imports.outer_html(rid)) as string;
  }

  it("set_attr and remove_attr edit an element's attributes", () => {
    const { imports, doc } = parse("<img data-src='a.jpg' alt='x'>");
    const [[sel, selLen], [src, srcLen], [url, urlLen], [alt, altLen]] = strings(
      "img",
      "src",
      "b.jpg",
      "alt"
    );
    const img = imports.select_first(doc, sel, selLen);

    expect(imports.set_attr(img, src, srcLen, url, urlLen)).toBe(0);
    expect(imports.remove_attr(img, alt, altLen)).toBe(0);
    expect(outerHtml(imports, img)).toBe('<img data-src="a.jpg" src="b.jpg">');
  });

  it("add_class and remove_class edit an element's classes", () => {
    const { imports, doc } = parse("<p class='a b'>x</p>");
    const [[sel, selLen], [c, cLen], [a, aLen]] = strings("p", "c", "a");
    const p = imports.select_first(doc, sel, selLen);

    expect(imports.add_class(p, c, cLen)).toBe(0);
    expect(imports.remove_class(p, a, aLen)).toBe(0);
    expect(outerHtml(imports, p)).toBe('<p class="b c">x</p>');
  });

  it("attribute and class mutations reject bad descriptors and empty strings", () => {
    const { imports, doc } = parse("<p>x</p>");
    const [[sel, selLen], [key, keyLen]] = strings("p", "id");
    const p = imports.select_first(doc, sel, selLen);

    expect(imports.set_attr(-1, key, keyLen, key, keyLen)).toBe(-1);
    expect(imports.set_attr(p, key, 0, key, keyLen)).toBe(-2);
    expect(imports.set_attr(p, key, keyLen, key, 0)).toBe(-2);
    expect(imports.remove_attr(9999, key, keyLen)).toBe(-1);
    expect(imports.remove_attr(p, key, 0)).toBe(-2);
    expect(imports.add_class(-1, key, keyLen)).toBe(-1);
    expect(imports.add_class(p, key, 0)).toBe(-2);
    expect(imports.remove_class(-1, key, keyLen)).toBe(-1);
    expect(imports.remove_class(p, key, 0)).toBe(-2);
  });

  function parseWithBase(html: string, baseUrl: string) {
    store = new GlobalStore("test.source");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createHtmlImports(store);
    store.writeString(html, 8);
    store.writeString(baseUrl, 4096);
    const doc = imports.parse(8, html.length, 4096, baseUrl.length);
    expect(doc).toBeGreaterThanOrEqual(0);
    return { imports, doc };
  }

  function absAttrs(
    imports: ReturnType<typeof createHtmlImports>,
    doc: number,
    attr: string
  ): (string | number)[] {
    const [[sel, selLen], [key, keyLen]] = strings("img", attr);
    const list = imports.select(doc, sel, selLen);
    return Array.from({ length: imports.size(list) }, (_, i) => {
      const rid = imports.attr(imports.get(list, i), key, keyLen);
      return rid < 0 ? rid : (store!.readStdValue(rid) as string);
    });
  }

  const IMAGES =
    "<img src='cover.jpg'>" +
    "<img src='/uploads/covers/a.jpg'>" +
    "<img src='//cdn.example.org/b.jpg'>" +
    "<img src='https://other.example.net/c.jpg'>" +
    "<img src=''>" +
    "<img alt='no src'>";

  it("abs: resolves attributes against the document's base URL", () => {
    const { imports, doc } = parseWithBase(IMAGES, "http://raw.example.com/manga/list?page=2");
    expect(absAttrs(imports, doc, "abs:src")).toEqual([
      "http://raw.example.com/manga/cover.jpg",
      "http://raw.example.com/uploads/covers/a.jpg",
      "http://cdn.example.org/b.jpg",
      "https://other.example.net/c.jpg",
      "http://raw.example.com/manga/list?page=2",
      -5,
    ]);
    // The plain attribute is untouched.
    expect(absAttrs(imports, doc, "src").slice(0, 2)).toEqual(["cover.jpg", "/uploads/covers/a.jpg"]);
  });

  it("abs: prefers the document's <base href>", () => {
    const { imports, doc } = parseWithBase(
      "<head><base href='/assets/'></head><body>" + IMAGES + "</body>",
      "https://raw.example.com/manga/1"
    );
    expect(absAttrs(imports, doc, "abs:src").slice(0, 3)).toEqual([
      "https://raw.example.com/assets/cover.jpg",
      "https://raw.example.com/uploads/covers/a.jpg",
      "https://cdn.example.org/b.jpg",
    ]);
  });

  it("abs: without a base URL keeps only absolute URLs", () => {
    const { imports, doc } = parse(IMAGES);
    expect(absAttrs(imports, doc, "abs:src")).toEqual([
      "",
      "",
      "",
      "https://other.example.net/c.jpg",
      "",
      -5,
    ]);
  });

  it("abs: uses an absolute <base href> when parsed without a base URL", () => {
    const { imports, doc } = parse("<base href='https://raw.example.com/a/'>" + IMAGES);
    expect(absAttrs(imports, doc, "abs:src").slice(0, 3)).toEqual([
      "https://raw.example.com/a/cover.jpg",
      "https://raw.example.com/uploads/covers/a.jpg",
      "https://cdn.example.org/b.jpg",
    ]);
  });

  it("base_uri returns the document's base URL from any node", () => {
    const { imports, doc } = parseWithBase("<div><img src='x.jpg'></div>", "https://raw.example.com/home");
    const [[sel, selLen]] = strings("img");
    const img = imports.select_first(doc, sel, selLen);
    expect(store!.readStdValue(imports.base_uri(doc))).toBe("https://raw.example.com/home");
    expect(store!.readStdValue(imports.base_uri(img))).toBe("https://raw.example.com/home");
  });

  it("base_uri follows <base href> and is empty without a base", () => {
    const withBase = parseWithBase("<base href='../x/'><p>a</p>", "https://raw.example.com/a/b/c");
    expect(store!.readStdValue(withBase.imports.base_uri(withBase.doc))).toBe("https://raw.example.com/a/x/");
    store!.destroy();

    const noBase = parse("<p>a</p>");
    expect(store!.readStdValue(noBase.imports.base_uri(noBase.doc))).toBe("");
  });

  it("abs: and base_uri work on fragments and documents loaded outside parse", () => {
    const baseUrl = "https://raw.example.com/m/";
    const html = "<img src='/uploads/covers/a.jpg'>";
    store = new GlobalStore("test.source");
    store.setMemory(new WebAssembly.Memory({ initial: 1 }));
    const imports = createHtmlImports(store);
    store.writeString(html, 8);
    store.writeString(baseUrl, 4096);
    const fragment = imports.parse_fragment(8, html.length, 4096, baseUrl.length);
    expect(absAttrs(imports, fragment, "abs:src")).toEqual(["https://raw.example.com/uploads/covers/a.jpg"]);

    // net.ts stores documents loaded this way for `html()` on a response.
    const $ = load(html, { baseURI: "https://raw.example.com/n/" });
    const root = $.root() as ReturnType<typeof $.root> & { _cheerioApi?: typeof $ };
    root._cheerioApi = $;
    const loaded = store.storeStdValue(root);
    expect(absAttrs(imports, loaded, "abs:src")).toEqual(["https://raw.example.com/uploads/covers/a.jpg"]);
    expect(store.readStdValue(imports.base_uri(loaded))).toBe("https://raw.example.com/n/");
  });
});

describe("resolveUrl", () => {
  it("matches SwiftSoup absUrl resolution", () => {
    const base = "https://raw.example.com/manga/1";
    expect(resolveUrl(base, "2")).toBe("https://raw.example.com/manga/2");
    expect(resolveUrl(base, "/uploads/x.jpg")).toBe("https://raw.example.com/uploads/x.jpg");
    expect(resolveUrl(base, "//cdn.example.org/x.jpg")).toBe("https://cdn.example.org/x.jpg");
    expect(resolveUrl("http://raw.example.com/", "//cdn.example.org/x.jpg")).toBe("http://cdn.example.org/x.jpg");
    expect(resolveUrl(base, "?page=2")).toBe("https://raw.example.com/manga/1?page=2");
    expect(resolveUrl(base, "../a b.jpg")).toBe("https://raw.example.com/a%20b.jpg");
    expect(resolveUrl(base, "")).toBe(base);
    expect(resolveUrl(base, "data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(resolveUrl("", "/x.jpg")).toBe("");
    expect(resolveUrl("not a url", "x.jpg")).toBe("");
    expect(resolveUrl("", "https://raw.example.com/x.jpg")).toBe("https://raw.example.com/x.jpg");
  });
});
