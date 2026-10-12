import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// dock.h's own tests, compiled by scripts/build-window.mjs beside studio-window.exe.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testExe = path.join(app, "build", "dock-test.exe");
const built = process.platform === "win32" && fs.existsSync(path.join(app, "dist", "studio-window.exe"));

describe.skipIf(!built)("docked mode: the rect protocol and where the window goes", () => {
  it("is built with the window", () => {
    expect(fs.existsSync(testExe)).toBe(true);
  });

  it("passes every case", () => {
    const r = spawnSync(testExe, [], { encoding: "utf-8", timeout: 20_000 });
    const lines = r.stdout.trim().split(/\r?\n/);
    expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("ok ")).length).toBeGreaterThanOrEqual(18);
    expect(r.status).toBe(0);
  });
});
