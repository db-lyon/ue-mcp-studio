/** Tool limits that used to stop the agent now say how to read on. */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OutputTail, grep, readFile, webFetch } from "../src/local-tools.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "studio-caps-"));

describe("shell output", () => {
  it("saves a long output whole and points at it", () => {
    const file = path.join(tmp(), "out.log");
    const t = new OutputTail(10, 10, file);
    for (let i = 0; i < 10; i++) t.push(`chunk${i}-`);
    expect(t.text()).toContain(`the whole output is saved at ${file}`);
    expect(fs.readFileSync(file, "utf-8")).toBe(Array.from({ length: 10 }, (_, i) => `chunk${i}-`).join(""));
  });

  it("writes nothing for a short output", () => {
    const file = path.join(tmp(), "out.log");
    const t = new OutputTail(100, 100, file);
    t.push("short");
    expect(t.text()).toBe("short");
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("read_file", () => {
  it("reads a long line on from a column", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "min.json"), "a".repeat(2000) + "B".repeat(500));
    const first = await readFile(dir, { path: "min.json" });
    expect(first.text).toContain("read on with column=2000");
    const rest = await readFile(dir, { path: "min.json", column: 2000 });
    expect(rest.text).toContain("B".repeat(500));
    expect(rest.text).not.toContain("line cut");
  });
});

describe("grep without ripgrep", () => {
  it("names the files too large to search rather than skipping them silently", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "small.log"), "needle\n");
    fs.writeFileSync(path.join(dir, "huge.log"), Buffer.alloc(5 * 1024 * 1024, 0x61));
    const r = await grep(dir, { pattern: "needle" }, undefined, false);
    expect(r.text).toContain("small.log:1:needle");
    expect(r.text).toMatch(/not searched, over 4 MB: huge\.log/);
  });
});

describe("web_fetch", () => {
  const page = "x".repeat(1500) + "TAIL";
  const fake = (async () => new Response(page, { headers: { "content-type": "text/plain" } })) as typeof fetch;

  it("reads a long page on in parts with offset", async () => {
    const first = await webFetch({ url: "https://e.test/", max_length: 1000 }, undefined, fake);
    expect(first.text).toContain("read on with offset=1000");
    const rest = await webFetch({ url: "https://e.test/", max_length: 1000, offset: 1000 }, undefined, fake);
    expect(rest.text).toContain("TAIL");
    expect(rest.text).not.toContain("read on with");
  });
});
