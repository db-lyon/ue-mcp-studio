/**
 * No touchable is an ancestor of a scroll view. On Android a Pressable that
 * becomes the JS responder makes its native view intercept every move of the
 * gesture (JSResponderHandler.onInterceptTouchEvent), so a ScrollView or
 * FlatList inside it is cancelled and never scrolls. A backdrop that closes a
 * sheet is a sibling behind the card instead (see WhatsNewSheet).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const TOUCHABLE = /^(Pressable|Touchable\w*)$/;
const SCROLLER = /^(ScrollView|FlatList|SectionList|VirtualizedList)$/;

const tag = (n: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName).getText();

/** "file:line Tag > Scroller" for each scroller found under a touchable in this source. */
export function scrollersInsideTouchables(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node, touchable: string | null) => {
    let inside = touchable;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tag(node);
      if (inside && SCROLLER.test(name)) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${inside} > ${name}`);
      if (TOUCHABLE.test(name)) inside = name;
    }
    ts.forEachChild(node, (c) => visit(c, inside));
  };
  visit(sf, null);
  return found;
}

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []));

describe("scroll views and touchables", () => {
  it("the scan sees a ScrollView inside a Pressable", () => {
    expect(scrollersInsideTouchables("a.tsx", "const A = () => <Pressable><View><ScrollView /></View></Pressable>;")).toEqual(["a.tsx:1 Pressable > ScrollView"]);
    expect(scrollersInsideTouchables("b.tsx", "const B = () => <><Pressable /><View><FlatList /></View></>;")).toEqual([]);
  });

  it("no Pressable or Touchable in apps/mobile/src wraps a ScrollView or FlatList", () => {
    const src = path.resolve(__dirname, "../src");
    const found = files(src).flatMap((f) => scrollersInsideTouchables(path.relative(src, f).replace(/\\/g, "/"), fs.readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });
});
