/**
 * One account source for chat, remote control and billing: the extension
 * makes one AccountSource and hands it to each, and no module reads
 * `ue-mcp login` for a token on its own.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => fs.readFileSync(path.join(src, f), "utf-8");
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

describe("the account source", () => {
  it("is made once in the extension and passed to chat, remote control and billing", () => {
    const index = read("index.ts");
    expect(index.match(/new AccountSource\(/g)).toHaveLength(1);
    expect(index).toMatch(/registerChat\([^)]*, account\)/);
    expect(index).toMatch(/registerRemote\(host, \{ account \}\)/);
    expect(index).toMatch(/registerBilling\(host, \{ account,/);
  });

  it("is the only reader of ue-mcp login: every other registryAccount use only builds one", () => {
    for (const f of files(src)) {
      if (f.endsWith("account-source.ts")) continue;
      for (const line of fs.readFileSync(f, "utf-8").split("\n").filter((l) => l.includes("registryAccount"))) {
        expect(line, path.relative(src, f)).toMatch(/new AccountSource\(.*registryAccount\(\)\)/);
      }
    }
  });
});
