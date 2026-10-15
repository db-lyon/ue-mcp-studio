/**
 * The machine tools against a temp folder: a real shell, real files, a fake web.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lineDiff } from "@ue-mcp-studio/shared";
import {
  OutputTail,
  approvalFor,
  detectShell,
  editFile,
  glob,
  globToRegExp,
  grep,
  htmlToText,
  planEdit,
  readFile,
  resolvePath,
  runShell,
  webFetch,
  writeFile,
} from "../src/local-tools.js";
import { executeTool, validateInput, type AgentHost } from "../src/tools.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-local-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the shell", () => {
  it("runs in the project folder and states the exit code", async () => {
    fs.writeFileSync(path.join(dir, "marker.txt"), "x");
    const r = await runShell("ls", dir, 30);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("marker.txt");
    expect(r.text.trim().endsWith("Exit code: 0")).toBe(true);
  });

  it("reports a failing command as an error with its exit code and output", async () => {
    const r = await runShell("echo oops 1>&2; exit 3", dir, 30);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("oops");
    expect(r.text).toContain("Exit code: 3");
  });

  it("stops a command that runs past its timeout", async () => {
    const started = Date.now();
    const r = await runShell("sleep 20", dir, 1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Timed out after 1 s");
  }, 15_000);

  it("stops a command when the turn is stopped", async () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 300);
    const r = await runShell("sleep 20", dir, 60, c.signal);
    expect(r.text).toContain("Stopped by the user.");
  }, 15_000);

  it("keeps the start and the end of a long output", () => {
    const t = new OutputTail(10, 10);
    t.push("0123456789");
    t.push("a".repeat(100));
    t.push("ZYXWVUTSRQ");
    const text = t.text();
    expect(text.startsWith("0123456789")).toBe(true);
    expect(text.endsWith("ZYXWVUTSRQ")).toBe(true);
    expect(text).toContain("100 characters cut from the middle: 120 in all");
  });

  it("picks Git Bash from the usual install folder on Windows, and PowerShell without it", () => {
    const pf = path.join(dir, "pf");
    fs.mkdirSync(path.join(pf, "Git", "bin"), { recursive: true });
    fs.writeFileSync(path.join(pf, "Git", "bin", "bash.exe"), "");
    expect(detectShell({ ProgramFiles: pf, PATH: "" }, "win32")).toMatchObject({ kind: "bash", name: "Git Bash", exe: path.join(pf, "Git", "bin", "bash.exe") });

    // WSL's bash in System32 is not Git Bash.
    const sys = path.join(dir, "Windows", "System32");
    fs.mkdirSync(sys, { recursive: true });
    fs.writeFileSync(path.join(sys, "bash.exe"), "");
    const ps = detectShell({ ProgramFiles: path.join(dir, "none"), PATH: sys, SystemRoot: path.join(dir, "Windows") }, "win32");
    expect(ps).toMatchObject({ kind: "powershell", name: "Windows PowerShell" });

    const other = path.join(dir, "tools");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "bash.exe"), "");
    expect(detectShell({ ProgramFiles: path.join(dir, "none"), PATH: [sys, other].join(path.delimiter) }, "win32")).toMatchObject({ kind: "bash", exe: path.join(other, "bash.exe") });
  });
});

describe("paths", () => {
  it("resolves relative paths against the project and keeps absolute ones", () => {
    expect(resolvePath(dir, "Docs/a.md")).toBe(path.join(dir, "Docs", "a.md"));
    const abs = path.join(os.tmpdir(), "elsewhere.txt");
    expect(resolvePath(dir, abs)).toBe(abs);
  });

  it.runIf(process.platform === "win32")("reads Git Bash's /c/ form as a drive path", () => {
    expect(resolvePath(dir, "/c/Users/x/file.txt")).toBe("C:\\Users\\x\\file.txt");
  });
});

describe("files", () => {
  it("reads with line numbers, from an offset, and says where to go on", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n");
    expect((await readFile(dir, { path: "a.txt" })).text).toBe("1\tone\n2\ttwo\n3\tthree\n4\tfour");
    const part = (await readFile(dir, { path: "a.txt", offset: 2, limit: 2 })).text;
    expect(part).toContain("2\ttwo\n3\tthree");
    expect(part).toContain("read on with offset=4");
    expect((await readFile(dir, { path: "missing.txt" })).isError).toBe(true);
  });

  it("refuses to read a binary file as text", async () => {
    fs.writeFileSync(path.join(dir, "b.uasset"), Buffer.from([0xc1, 0x83, 0x2a, 0x9e, 0, 0, 1]));
    const r = await readFile(dir, { path: "b.uasset" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("binary");
  });

  it("writes a file, creating its folders", () => {
    const r = writeFile(dir, { path: "Docs/new/notes.md", content: "a\nb" });
    expect(r.text).toContain("Created");
    expect(fs.readFileSync(path.join(dir, "Docs", "new", "notes.md"), "utf-8")).toBe("a\nb");
    expect(writeFile(dir, { path: "Docs/new/notes.md", content: "c" }).text).toContain("Wrote");
  });

  it("edits only a unique match, unless every one is asked for", () => {
    expect(planEdit("a x a", { path: "f", old_string: "a", new_string: "b" })).toEqual({ error: expect.stringContaining("appears 2 times") });
    expect(planEdit("a x a", { path: "f", old_string: "a", new_string: "b", replace_all: true })).toEqual({ next: "b x b", count: 2 });
    expect(planEdit("a x a", { path: "f", old_string: "a x", new_string: "c" })).toEqual({ next: "c a", count: 1 });
    expect(planEdit("abc", { path: "f", old_string: "zzz", new_string: "y" })).toEqual({ error: expect.stringContaining("not found") });
    expect(planEdit("abc", { path: "f", old_string: "b", new_string: "b" })).toEqual({ error: expect.stringContaining("the same") });
    // A $ in the new text is taken as it is.
    expect(planEdit("price", { path: "f", old_string: "price", new_string: "$& $1" })).toEqual({ next: "$& $1", count: 1 });
  });

  it("matches plain newlines against a file with Windows line endings", () => {
    fs.writeFileSync(path.join(dir, "w.cpp"), "int a;\r\nint b;\r\n");
    const r = editFile(dir, { path: "w.cpp", old_string: "int a;\nint b;", new_string: "int a;\nint c;" });
    expect(r.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, "w.cpp"), "utf-8")).toBe("int a;\r\nint c;\r\n");
  });

  it("leaves the file alone when an edit fails", () => {
    fs.writeFileSync(path.join(dir, "f.txt"), "same same");
    const r = editFile(dir, { path: "f.txt", old_string: "same", new_string: "diff" });
    expect(r.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf-8")).toBe("same same");
  });
});

describe("glob and grep", () => {
  beforeEach(() => {
    for (const f of ["Source/Game/A.cpp", "Source/Game/A.h", "Source/B.cpp", "Docs/WorldGen/PASSES.md", "Intermediate/Gen.cpp", ".git/config"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), f.endsWith(".md") ? "# Passes\nPass 1: terrain\n" : `// ${f}\nint TODO_value = 1;\n`);
    }
  });

  it("matches globs by path, and a bare name at any depth", () => {
    expect(globToRegExp("Source/**/*.cpp").test("Source/Game/A.cpp")).toBe(true);
    expect(globToRegExp("Source/**/*.cpp").test("Source/B.cpp")).toBe(true);
    expect(globToRegExp("*.{h,cpp}").test("Source/Game/A.h")).toBe(true);
    expect(globToRegExp("Source/*.cpp").test("Source/Game/A.cpp")).toBe(false);
  });

  it("lists matching files and skips generated folders unless named", () => {
    const r = glob(dir, { pattern: "**/*.cpp" });
    expect(r.text).toContain("Source/Game/A.cpp");
    expect(r.text).toContain("Source/B.cpp");
    expect(r.text).not.toContain("Intermediate");
    expect(glob(dir, { pattern: "Intermediate/*.cpp" }).text).toContain("Intermediate/Gen.cpp");
  });

  it("searches contents with the JS fallback", async () => {
    const r = await grep(dir, { pattern: "TODO_\\w+", glob: "*.h" }, undefined, false);
    expect(r.text).toContain("Source/Game/A.h:2:int TODO_value = 1;");
    expect(r.text).not.toContain("A.cpp");
    expect((await grep(dir, { pattern: "nothing here" }, undefined, false)).text).toContain("No matches");
    expect((await grep(dir, { pattern: "(" }, undefined, false)).isError).toBe(true);
  });

  it("searches contents with ripgrep when there is one", async () => {
    const r = await grep(dir, { pattern: "terrain", path: "Docs" });
    expect(r.text).toMatch(/PASSES\.md:2:Pass 1: terrain/);
  });
});

describe("the web", () => {
  it("reads a page as markdown, cut to the length asked", async () => {
    const html = "<html><head><title>Doc</title><style>x{}</style></head><body><h2>Install</h2><p>Run <code>npm i</code> &amp; go.</p><ul><li>One</li><li><a href=\"/two\">Two</a></li></ul><script>evil()</script></body></html>";
    const fake = (async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
    const r = await webFetch({ url: "https://example.com/doc" }, undefined, fake);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("# Doc");
    expect(r.text).toContain("## Install");
    expect(r.text).toContain("Run `npm i` & go.");
    expect(r.text).toContain("- [Two](/two)");
    expect(r.text).not.toContain("evil");
  });

  it("returns JSON as it is, and an error status as an error", async () => {
    const fake = (async () => new Response("{\"a\":1}", { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const r = await webFetch({ url: "https://api.example.com/x" }, undefined, fake);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("(404, application/json)");
    expect(r.text).toContain("{\"a\":1}");
  });

  it("turns entities and breaks into text", () => {
    expect(htmlToText("a<br>b&#39;s &lt;tag&gt;")).toBe("a\nb's <tag>");
  });
});

describe("approval previews", () => {
  it("shows an edit as a diff of the file", () => {
    fs.writeFileSync(path.join(dir, "c.ini"), "a\nb\nc\n");
    const p = approvalFor(dir, "edit_file", { path: "c.ini", old_string: "b", new_string: "B" });
    expect(p?.path).toBe(path.join(dir, "c.ini"));
    expect(p?.diff).toEqual([{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }]);
  });

  it("asks nothing for an edit that would fail anyway", () => {
    fs.writeFileSync(path.join(dir, "c.ini"), "a");
    expect(approvalFor(dir, "edit_file", { path: "c.ini", old_string: "zzz", new_string: "y" })).toBeNull();
  });

  it("marks a new file as created, and shows a command with its folder", () => {
    expect(approvalFor(dir, "write_file", { path: "n.txt", content: "x" })).toMatchObject({ creates: true, diff: [{ op: "+", text: "x" }] });
    expect(approvalFor(dir, "shell", { command: "git status" })).toEqual({ tool: "shell", command: "git status", cwd: dir });
  });

  it("cuts unchanged runs in a diff down to the lines around a change", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const d = lineDiff(before, before.replace("l10", "X"));
    expect(d[0]).toEqual({ op: "gap", count: 7 });
    expect(d.filter((l) => l.op === "-" || l.op === "+")).toEqual([{ op: "-", text: "l10" }, { op: "+", text: "X" }]);
    expect(d[d.length - 1]).toEqual({ op: "gap", count: 6 });
  });
});

describe("the executor", () => {
  const host = { projectDir: "" } as AgentHost;

  it("checks the machine tools' inputs", () => {
    expect(validateInput("shell", {})).toBe("shell needs command");
    expect(validateInput("edit_file", { path: "a", old_string: "x" })).toBe("edit_file needs old_string and new_string");
    expect(validateInput("web_fetch", { url: "file:///etc/passwd" })).toContain("http");
    expect(validateInput("read_file", { path: "a", offset: 3 })).toBeNull();
  });

  it("runs them through the shared executor", async () => {
    host.projectDir = dir;
    const w = await executeTool(host, "write_file", { path: "x.txt", content: "hello" });
    expect(w).toMatchObject({ outcome: "done", isError: false });
    const r = await executeTool(host, "read_file", { path: "x.txt" });
    expect(r.text).toBe("1\thello");
    const bad = await executeTool(host, "edit_file", { path: "x.txt", old_string: "nope", new_string: "y" });
    expect(bad).toMatchObject({ outcome: "error", isError: true });
  });
});
