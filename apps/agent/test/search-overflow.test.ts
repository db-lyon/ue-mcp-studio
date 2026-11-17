/**
 * A search with more results than fit saves the whole list and says where (#461).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { glob, grep, imageTooLarge } from "../src/local-tools.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-overflow-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const savedPath = (text: string): string => {
  const m = /saved at (.+?), read it there/.exec(text);
  expect(m).not.toBeNull();
  return m![1];
};

describe("results over the cap", () => {
  it("glob saves every match and names the file", async () => {
    for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    const r = await glob(dir, { pattern: "*.txt" });
    const file = savedPath(r.text);
    expect(fs.readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(520);
    fs.rmSync(file);
  });

  it("glob under the cap saves nothing", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    expect((await glob(dir, { pattern: "*.txt" })).text).not.toContain("saved at");
  });

  it("grep saves every match past the cap", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), Array.from({ length: 450 }, (_, i) => `hit ${i}`).join("\n"));
    const r = await grep(dir, { pattern: "hit" }, undefined, false);
    expect(r.text).toContain("more matches not shown");
    const file = savedPath(r.text);
    expect(fs.readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(450);
    fs.rmSync(file);
  });
});

describe("an image too large to open", () => {
  it("suggests a smaller copy through the shell", () => {
    const text = imageTooLarge(path.join(dir, "big.png"), 300_000_000);
    expect(text).toContain("big-small.jpg");
    expect(text).toContain("read the copy with read_file");
  });
});
