import { describe, expect, it } from "vitest";
import { tokenizeYaml, type YamlToken } from "./yaml-tokens";

/** The tokens with a type, as [type, text] pairs. */
const typed = (src: string) => tokenizeYaml(src).filter((t) => t.type).map((t) => [t.type, t.text]);
const joined = (tokens: YamlToken[]) => tokens.map((t) => t.text).join("");

describe("tokenizeYaml", () => {
  it("colours keys, strings, numbers, booleans, null and comments", () => {
    expect(typed('name: "Studio" # the product\nport: 8080\nratio: -1.5e3\non: true\nnone: ~\nplain: hello world\n')).toEqual([
      ["key", "name"], ["punct", ":"], ["string", '"Studio"'], ["comment", "# the product"],
      ["key", "port"], ["punct", ":"], ["number", "8080"],
      ["key", "ratio"], ["punct", ":"], ["number", "-1.5e3"],
      ["key", "on"], ["punct", ":"], ["bool", "true"],
      ["key", "none"], ["punct", ":"], ["null", "~"],
      ["key", "plain"], ["punct", ":"], ["string", "hello world"],
    ]);
  });

  it("colours list dashes, anchors, aliases, tags and document markers", () => {
    expect(typed("---\nbase: &defaults\n  retries: 3\nlist:\n  - one\n  - *defaults\n  - !!str 42\n  - - nested\n...\n")).toEqual([
      ["doc", "---"],
      ["key", "base"], ["punct", ":"], ["anchor", "&defaults"],
      ["key", "retries"], ["punct", ":"], ["number", "3"],
      ["key", "list"], ["punct", ":"],
      ["dash", "-"], ["string", "one"],
      ["dash", "-"], ["anchor", "*defaults"],
      ["dash", "-"], ["tag", "!!str"], ["number", "42"],
      ["dash", "-"], ["dash", "-"], ["string", "nested"],
      ["doc", "..."],
    ]);
  });

  it("reads a key after a dash and quoted keys", () => {
    expect(typed("- name: a\n  'it''s': 'x'\n")).toEqual([
      ["dash", "-"], ["key", "name"], ["punct", ":"], ["string", "a"],
      ["key", "'it''s'"], ["punct", ":"], ["string", "'x'"],
    ]);
  });

  it("keeps a # inside a string or a word out of comments", () => {
    expect(typed('a: "x # y"\nb: c#d\nurl: http://x.io:80/p\n')).toEqual([
      ["key", "a"], ["punct", ":"], ["string", '"x # y"'],
      ["key", "b"], ["punct", ":"], ["string", "c#d"],
      ["key", "url"], ["punct", ":"], ["string", "http://x.io:80/p"],
    ]);
  });

  it("colours flow collections", () => {
    expect(typed("tags: [a, 2, {k: true}]\n")).toEqual([
      ["key", "tags"], ["punct", ":"], ["punct", "["], ["string", "a"], ["punct", ","], ["number", "2"], ["punct", ","],
      ["punct", "{"], ["key", "k"], ["punct", ":"], ["bool", "true"], ["punct", "}]"],
    ]);
  });

  it("treats a block scalar's indented lines as one string and returns to keys after it", () => {
    expect(typed("note: |-\n  line: one\n\n  # not a comment\nnext: 1\n")).toEqual([
      ["key", "note"], ["punct", ":"], ["punct", "|-"],
      ["string", "line: one"], ["string", "# not a comment"],
      ["key", "next"], ["punct", ":"], ["number", "1"],
    ]);
  });

  it("ends a block scalar under a list item at the item's key column", () => {
    expect(typed("- run: >\n    folded\n  other: x\n")).toEqual([
      ["dash", "-"], ["key", "run"], ["punct", ":"], ["punct", ">"], ["string", "folded"],
      ["key", "other"], ["punct", ":"], ["string", "x"],
    ]);
  });

  it("carries an open quoted string to the next line", () => {
    expect(typed('a: "one\n  two"\nb: 1\n')).toEqual([
      ["key", "a"], ["punct", ":"], ["string", '"one'], ["string", '  two"'],
      ["key", "b"], ["punct", ":"], ["number", "1"],
    ]);
  });

  it("never drops or adds a character, whatever the input", () => {
    const samples = [
      "",
      "\n\n",
      "a:\r\n  - b\r\n",
      "key: [unclosed\n  - 'open\n\tx: 1\n",
      ": : : # #\n- - -\n|\n>\n&\n*\n!\n\"\\\"\n'''\n",
      "context:\n  strategy: micro\nserver:\n  mode: daemon # comment\n",
    ];
    for (const s of samples) expect(joined(tokenizeYaml(s))).toBe(s);
    // Random printable YAML-ish noise.
    const alphabet = "ab1.-:#'\"&*![]{},|> \t\n";
    let seed = 7;
    for (let n = 0; n < 300; n++) {
      let s = "";
      for (let i = 0; i < 80; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        s += alphabet[seed % alphabet.length];
      }
      expect(joined(tokenizeYaml(s))).toBe(s);
    }
  });
});
