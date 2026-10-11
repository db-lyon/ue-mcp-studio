import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { diffOf, listChanges, parseGitChanges, parseLetterStatus, parseP4Opened } from "../src/vcs.js";

describe("reading changed files", () => {
  it("reads git's status entries, renames and untracked files included", () => {
    const out = [" M Config/DefaultEngine.ini", "A  Content/New.uasset", "R  Content/B.uasset", "Content/A.uasset", "?? Notes.md", " D Old.txt", "UU Source/X.cpp", ""].join("\0");
    expect(parseGitChanges(out)).toEqual([
      { path: "Config/DefaultEngine.ini", status: "modified" },
      { path: "Content/New.uasset", status: "added" },
      { path: "Content/B.uasset", status: "renamed" },
      { path: "Notes.md", status: "untracked" },
      { path: "Old.txt", status: "deleted" },
      { path: "Source/X.cpp", status: "conflicted" },
    ]);
  });

  it("reads Perforce's opened files with their changelist", () => {
    expect(parseP4Opened("//Game/main/A.uasset|edit|default\n//Game/main/B.uasset|add|1234\n")).toEqual([
      { path: "//Game/main/A.uasset", status: "modified", changelist: "default" },
      { path: "//Game/main/B.uasset", status: "added", changelist: "1234" },
    ]);
  });

  it("reads the letter status Subversion and Plastic print", () => {
    expect(parseLetterStatus("M       Config/A.ini\n?       New.txt\nD       Gone.txt\n").map((c) => c.status)).toEqual(["modified", "untracked", "deleted"]);
  });
});

describe("a project under git", () => {
  const repo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-git-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "Notes.txt"), "one\ntwo\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    fs.writeFileSync(path.join(dir, "Notes.txt"), "one\nthree\n");
    fs.writeFileSync(path.join(dir, "Added.md"), "# new\n");
    return dir;
  };

  it("lists the changed and new files, and diffs each", async () => {
    const dir = repo();
    const r = await listChanges(dir);
    expect(r.changes).toEqual(expect.arrayContaining([{ path: "Notes.txt", status: "modified" }, { path: "Added.md", status: "untracked" }]));
    const d = await diffOf(dir, "Notes.txt");
    expect(d.diff).toMatch(/-two/);
    expect(d.diff).toMatch(/\+three/);
    expect((await diffOf(dir, "Added.md")).diff).toBe("+# new\n+");
    expect((await diffOf(dir, "Content/Map.umap")).reason).toMatch(/binary/);
    expect((await diffOf(dir, "../outside.txt")).reason).toMatch(/Not a path/);
  });
});
