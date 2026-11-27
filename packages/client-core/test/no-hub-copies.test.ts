/**
 * Studio declares no Playtest Hub type of its own: every one comes from
 * ue-mcp/daemon (or ue-mcp/hub, the same declarations), so a change to the
 * hub's contract reaches Studio through the compiler rather than drifting in
 * a copy. This reads the names ue-mcp's hub contract declares and fails on
 * any interface or type alias of the same name in Studio's source.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const contract = path.join(root, "node_modules", "ue-mcp", "dist", "contract");

/** Studio's own types that share a name with a hub type and mean something else, each with why. */
const STUDIO_OWN: Record<string, string> = {
  BusyState: "Studio's GET /v1/ext/studio/busy answer, whose calls name Studio's agents as source \"studio\"",
  BusyCall: "a call in Studio's busy answer, as above",
  RunState: "a conversation's state in the editor consent ledger (apps/agent/src/consent.ts)",
  Check: "the refusal screen's version check (apps/client-web/src/views/Refused.tsx)",
};

function hubTypeNames(): Set<string> {
  const names = new Set<string>();
  for (const f of ["hub.d.ts", "hub-performers.d.ts", "hub-ports.d.ts"]) {
    const text = fs.readFileSync(path.join(contract, f), "utf8");
    for (const m of text.matchAll(/export (?:declare )?(?:interface|type) (\w+)/g)) names.add(m[1]!);
  }
  return names;
}

function studioDeclarations(): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+(\w+)\b|type\s+(\w+)\s*(?:<[^=]*>)?\s*=)/gm)) out.push({ file: path.relative(root, p), name: (m[1] ?? m[2])! });
      }
    }
  };
  for (const top of ["apps", "packages"]) walk(path.join(root, top));
  return out;
}

describe("hub types", () => {
  it("come from ue-mcp: Studio redeclares none", () => {
    const hub = hubTypeNames();
    expect(hub.size).toBeGreaterThan(40);
    expect(hub.has("Arrangement") && hub.has("SuiteState") && hub.has("Clip")).toBe(true);
    const copies = studioDeclarations().filter((d) => hub.has(d.name) && !(d.name in STUDIO_OWN)).map((d) => `${d.file}: ${d.name}`);
    expect(copies).toEqual([]);
  });

  it("finds a copy when there is one", () => {
    const sample = "export interface Arrangement {\n  id: string;\n}\ntype SuiteState = { id: string };\n";
    const found = [...sample.matchAll(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+(\w+)\b|type\s+(\w+)\s*(?:<[^=]*>)?\s*=)/gm)].map((m) => m[1] ?? m[2]);
    expect(found).toEqual(["Arrangement", "SuiteState"]);
  });
});
