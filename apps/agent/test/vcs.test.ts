import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectVcs, parseGitStatus, parseP4Info, parsePlasticSelector, run, type Run } from "../src/vcs.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "studio-vcs-"));
const fake = (answers: Record<string, string | null>): Run => async (cmd, args) => answers[`${cmd} ${args[0] === "-ztag" ? args[3] : args[0]}`] ?? null;

describe("reading source control output", () => {
  it("reads git's branch, ahead and behind, and changed paths", () => {
    const out = ["# branch.oid 1234567890abcdef", "# branch.head feat/lights", "# branch.upstream origin/feat/lights", "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 a b Content/A.uasset", "? Content/New.uasset", ""].join("\n");
    expect(parseGitStatus(out)).toEqual({ branch: "feat/lights", ahead: 2, behind: 1, changes: 2 });
  });

  it("names a detached HEAD by its commit", () => {
    expect(parseGitStatus("# branch.oid abcdef1234\n# branch.head (detached)\n").branch).toBe("abcdef12");
  });

  it("reads a Plastic selector's branch", () => {
    expect(parsePlasticSelector('repository "Game@cloud"\n  path "/"\n    smartbranch "/main/art"')).toBe("/main/art");
    expect(parsePlasticSelector('rep "Game" path "/" br "/main" co "/main"')).toBe("/main");
  });

  it("reads p4 info, and knows when there is no client", () => {
    expect(parseP4Info("dev_ws|D:\Game|//Game/main|ana\n")).toEqual({ client: "dev_ws", root: "D:\Game", stream: "//Game/main", user: "ana" });
    expect(parseP4Info("*unknown*|||\n")).toBeNull();
  });
});

describe("finding the project's source control", () => {
  it("finds git above the project, and still names the branch without git installed", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const project = path.join(root, "Game");
    fs.mkdirSync(project);
    expect(await detectVcs(project, fake({}))).toMatchObject({ kind: "git", branch: "main", changes: null });
    expect(await detectVcs(project, fake({ "git status": "# branch.head main\n? x\n" }))).toMatchObject({ kind: "git", branch: "main", changes: 1, ahead: 0 });
  });

  it("finds a Plastic workspace by its folder", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".plastic"));
    fs.writeFileSync(path.join(root, ".plastic", "plastic.selector"), 'rep "Game" path "/" br "/main/levels"');
    expect(await detectVcs(root, fake({ "cm status": "CH Content/A.uasset\nCH Content/B.uasset\n" }))).toMatchObject({ kind: "plastic", branch: "/main/levels", changes: 2 });
  });

  it("finds a Perforce workspace whose root holds the project, by stream", async () => {
    const root = tmp();
    const r = fake({ "p4 info": `dev_ws|${root}|//Game/main|ana`, "p4 opened": "//Game/main/A.uasset\n//Game/main/B.uasset\n//Game/main/C.uasset\n" });
    expect(await detectVcs(root, r)).toMatchObject({ kind: "perforce", branch: "//Game/main", detail: "workspace dev_ws", changes: 3 });
  });

  it("ignores a Perforce workspace elsewhere, and reports nothing without source control", async () => {
    const root = tmp();
    expect(await detectVcs(root, fake({ "p4 info": "dev_ws|Z:\Elsewhere||ana" }))).toBeNull();
    expect(await detectVcs(root, fake({}))).toBeNull();
  });

  it("reads this repository with the real git", async () => {
    const found = await detectVcs(process.cwd(), run);
    expect(found?.kind).toBe("git");
    expect(found?.branch).toBeTruthy();
  });
});
