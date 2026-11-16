/**
 * Pi Durable, pi-ai and pi-claude-code are reached through one module,
 * durable/pi.ts, at exact versions: an API change upstream touches that file
 * alone, and the daemon's bundle never loads them.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : []));
const imports = (file: string): string[] => [...fs.readFileSync(file, "utf-8").matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);

describe("the durable runtime's dependencies", () => {
  it("imports Pi Durable, pi-ai and pi-claude-code only in durable/pi.ts", () => {
    const offenders = files(src)
      .filter((f) => path.relative(src, f).replace(/\\/g, "/") !== "durable/pi.ts")
      .filter((f) => imports(f).some((m) => m.startsWith("@earendil-works/") || m === "studio-pi-claude-code"));
    expect(offenders.map((f) => path.relative(src, f))).toEqual([]);
  });

  it("pins exact versions", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(src, "..", "package.json"), "utf-8")) as { dependencies: Record<string, string> };
    const pins = Object.entries(pkg.dependencies).filter(([n]) => n.startsWith("@earendil-works/"));
    expect(pins.length).toBeGreaterThanOrEqual(4);
    for (const [name, v] of pins) expect(v, name).toMatch(/^\d+\.\d+\.\d+$|^https:\/\/codeload\.github\.com\/.+\/tar\.gz\/[0-9a-f]{40}$/);
  });

  it("keeps the daemon's side free of them: the runtime, the client and the protocol", () => {
    for (const f of ["durable/runtime.ts", "durable/client.ts", "durable/protocol.ts", "durable/routes.ts", "durable/extension.ts"]) {
      expect(imports(path.join(src, f)).filter((m) => m.includes("pi.js")), f).toEqual([]);
    }
  });
});
