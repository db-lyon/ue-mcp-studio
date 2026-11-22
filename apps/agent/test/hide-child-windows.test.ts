import { describe, expect, it } from "vitest";
import { installWindowsHide, withWindowsHide } from "../src/hide-child-windows.js";

const afterArgs = (a: unknown[]): number => (Array.isArray(a[1]) ? 2 : 1);

describe("withWindowsHide", () => {
  it("adds options when a spawn call has none", () => {
    expect(withWindowsHide(["rg", ["-n", "x"]], afterArgs)).toEqual(["rg", ["-n", "x"], { windowsHide: true }]);
    expect(withWindowsHide(["rg"], afterArgs)).toEqual(["rg", { windowsHide: true }]);
  });

  it("defaults windowsHide in existing options and keeps an explicit false", () => {
    expect(withWindowsHide(["rg", ["x"], { cwd: "C:/p" }], afterArgs)).toEqual(["rg", ["x"], { cwd: "C:/p", windowsHide: true }]);
    expect(withWindowsHide(["rg", { cwd: "C:/p" }], afterArgs)).toEqual(["rg", { cwd: "C:/p", windowsHide: true }]);
    expect(withWindowsHide(["rg", ["x"], { windowsHide: false }], afterArgs)).toEqual(["rg", ["x"], { windowsHide: false }]);
  });

  it("puts options before a callback", () => {
    const cb = () => {};
    expect(withWindowsHide(["git", ["status"], cb], afterArgs)).toEqual(["git", ["status"], { windowsHide: true }, cb]);
    expect(withWindowsHide(["dir", cb], () => 1)).toEqual(["dir", { windowsHide: true }, cb]);
  });
});

describe("installWindowsHide", () => {
  it("wraps every child_process launcher so the call it makes carries windowsHide", () => {
    const calls: unknown[][] = [];
    const record = (...args: unknown[]) => { calls.push(args); return "ok"; };
    const execFile = Object.assign((...args: unknown[]) => record(...args), { [Symbol.for("custom")]: 1 });
    const fake = { spawn: record, spawnSync: record, execFile, execFileSync: record, fork: record, exec: record, execSync: record };
    installWindowsHide(fake as never);
    (fake.spawn as (...a: unknown[]) => unknown)("rg", ["x"], { cwd: "." });
    (fake.exec as (...a: unknown[]) => unknown)("dir");
    (fake.execFile as (...a: unknown[]) => unknown)("git", ["status"]);
    expect(calls).toEqual([
      ["rg", ["x"], { cwd: ".", windowsHide: true }],
      ["dir", { windowsHide: true }],
      ["git", ["status"], { windowsHide: true }],
    ]);
    expect((fake.execFile as unknown as Record<symbol, unknown>)[Symbol.for("custom")]).toBe(1);
  });
});
