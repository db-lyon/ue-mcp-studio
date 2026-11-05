/**
 * Desktop, the paired browser and the Android app move together. Two gates,
 * in npm test so a pull request cannot pass without them:
 *
 * 1. Every client-web visual QA scenario has an entry in the phone's parity
 *    inventory (apps/mobile/visual-qa/parity.ts): the area that ports it, or
 *    why a paired phone never shows it. A new web view without its phone
 *    counterpart, or a stated exception, fails here.
 * 2. Logic and strings shared through packages/client-core or packages/shared
 *    are imported, never copied: neither client defines its own function or
 *    constant under a name those packages export.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../../client-web/src/visual-qa/daemon";
import { PARITY } from "../visual-qa/parity";

const repo = path.resolve(__dirname, "../../..");

describe("phone parity inventory", () => {
  it("gives every web scenario a phone port or a reason it never reaches a phone", () => {
    const missing = Object.keys(SCENARIOS).filter((n) => !PARITY[n]);
    expect(missing, "add each to apps/mobile/visual-qa/parity.ts with its owner, or notOnPhone and why").toEqual([]);
  });

  it("lists no scenario the web client no longer has", () => {
    expect(Object.keys(PARITY).filter((n) => !SCENARIOS[n])).toEqual([]);
  });

  it("says for each entry either who ports it or why it is not on a phone", () => {
    const bad = Object.entries(PARITY).filter(([, e]) => !e.owner === !(e.notOnPhone && e.notOnPhone.trim().length > 20)).map(([n]) => n);
    expect(bad).toEqual([]);
  });
});

/** The names a package exports from its own source: functions, constants and classes. */
function exportedNames(dir: string): Set<string> {
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
        for (const m of fs.readFileSync(p, "utf8").matchAll(/^export (?:async )?(?:function\*?|const|class) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    }
  };
  walk(dir);
  return names;
}

/** Top-level definitions in a client's source, as file: name. */
function definitions(dir: string): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "visual-qa" && e.name !== "node_modules") walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
        for (const m of fs.readFileSync(p, "utf8").matchAll(/^(?:export )?(?:async )?(?:function\*?|const|class) ([A-Za-z_$][\w$]*)\b(?! = (?:\w+\.)?\w+;)/gm)) out.push({ file: path.relative(repo, p).replace(/\\/g, "/"), name: m[1] });
    }
  };
  walk(dir);
  return out;
}

/**
 * Definitions that share a name with client-core but are not copies of it, each with why.
 * An entry here is a tracked exception: remove it when the web client moves onto client-core's version.
 */
const EXCEPTIONS: Record<string, string> = {
  "apps/client-web/src/api.ts: subscribeEvents": "The web client's own same-origin fetch stream; client-core's takes a Transport. Moving the web onto it is tracked in apps/mobile/README.md.",
  "apps/client-web/src/api.ts: daemonIdentity": "Read with the web client's same-origin fetch, as subscribeEvents above.",
  "apps/client-web/src/api.ts: notThere": "Tests the web client's ApiError; client-core's tests its HttpError. Goes with the move above.",
};

describe("shared logic is imported, not copied", () => {
  const shared = new Set([...exportedNames(path.join(repo, "packages/client-core/src")), ...exportedNames(path.join(repo, "packages/shared/src"))]);

  it("keeps no stale exception", () => {
    const all = ["apps/client-web/src", "apps/mobile/src"].flatMap((c) => definitions(path.join(repo, c))).map((d) => `${d.file}: ${d.name}`);
    expect(Object.keys(EXCEPTIONS).filter((k) => !all.includes(k))).toEqual([]);
  });

  for (const client of ["apps/client-web/src", "apps/mobile/src"]) {
    it(`${client} defines nothing client-core or shared exports`, () => {
      const copies = definitions(path.join(repo, client)).filter((d) => shared.has(d.name) && !EXCEPTIONS[`${d.file}: ${d.name}`]);
      expect(copies.map((c) => `${c.file}: ${c.name}`), "import it from @ue-mcp-studio/client-core or @ue-mcp-studio/shared instead").toEqual([]);
    });
  }
});
