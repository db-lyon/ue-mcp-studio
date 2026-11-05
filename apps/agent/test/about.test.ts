import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relayName, studioAbout } from "../src/about.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(file?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-about-"));
  dirs.push(dir);
  if (file) fs.writeFileSync(path.join(dir, file), "{}");
  return dir;
}

describe("GET /about", () => {
  it("names the project as the relay lists it, so a paired device's drawer shows the same name", () => {
    const dir = project("Vale.uproject");
    const about = studioAbout("0.1.25-beta.43", { version: "1.4.12", projectDir: dir, ui: { active: () => null } } as never);
    expect(about.name).toBe(`Vale on ${os.hostname()}`);
    expect(relayName(dir)).toBe(about.name);
  });

  it("falls back to the folder's name without a .uproject", () => {
    const dir = project();
    expect(relayName(dir)).toBe(`${path.basename(dir)} on ${os.hostname()}`);
  });
});
