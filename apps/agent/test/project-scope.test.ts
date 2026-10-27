import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { callInsideProject, commandInsideProject, insideProject } from "../src/project-scope.js";

const root = path.join(os.tmpdir(), "Proj");
const outside = path.join(os.tmpdir(), "Other");

describe("insideProject", () => {
  it("takes the folder and anything under it, and nothing beside it", () => {
    expect(insideProject(root, root)).toBe(true);
    expect(insideProject(root, path.join(root, "Content", "A.uasset"))).toBe(true);
    expect(insideProject(root, outside)).toBe(false);
    expect(insideProject(root, `${root}Two`)).toBe(false);
  });
});

describe("commandInsideProject", () => {
  const inside = (c: string) => commandInsideProject(root, c);
  it("allows commands that name only relative paths, URLs and null devices", () => {
    expect(inside("git status")).toBe(true);
    expect(inside("rm -rf Saved/Logs")).toBe(true);
    expect(inside("ls Source/../Content 2>/dev/null")).toBe(true);
    expect(inside("curl -s https://example.com/a > out.json")).toBe(true);
    expect(inside(`cat "${path.join(root, "a.txt")}"`)).toBe(true);
  });
  it("asks about absolute paths elsewhere, climbing out, the home folder and paths known only at run time", () => {
    expect(inside(`rm -rf "${outside}"`)).toBe(false);
    expect(inside("cat ../secrets.txt")).toBe(false);
    expect(inside("rm -rf /")).toBe(false);
    expect(inside("ls ~/Documents")).toBe(false);
    expect(inside("cd")).toBe(false);
    expect(inside("git status && cd")).toBe(false);
    expect(inside("rm -rf $HOME/x")).toBe(false);
    expect(inside("Remove-Item $env:TEMP/x")).toBe(false);
    expect(inside("del %USERPROFILE%/x")).toBe(false);
    expect(inside("rm -rf $(pwd)/..")).toBe(false);
    expect(inside(String.raw`dir \\server\share`)).toBe(false);
  });
});

describe("callInsideProject", () => {
  it("reads a file change's path against the project folder", () => {
    expect(callInsideProject(root, "write_file", { path: "Config/DefaultGame.ini" })).toBe(true);
    expect(callInsideProject(root, "edit_file", { path: path.join(outside, "a.txt") })).toBe(false);
    expect(callInsideProject(root, "edit_file", { path: "../a.txt" })).toBe(false);
    expect(callInsideProject(root, "shell", { command: "git status" })).toBe(true);
  });
});
