/** The one link model: every markdown link target is web, asset, file or none, and the viewer that opens files. */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { FileReadResponse } from "@ue-mcp-studio/shared";
import { FileViewer, classifyLink, fileLines, normalizeFile, remarkReplyLinks, resolveFileLink, studioApi, type MdNode, type Reply } from "../src/index.js";

describe("classifyLink", () => {
  it("opens web pages and mail outside Studio", () => {
    for (const url of ["https://ue-mcp.com/docs/", "http://localhost:5173/x", "HTTPS://Example.com", "mailto:a@b.c"]) expect(classifyLink(url)).toEqual({ kind: "web", url });
  });

  it("keeps object paths as exact asset links", () => {
    expect(classifyLink("/Game/PCG/SG_A")).toEqual({ kind: "asset", path: "/Game/PCG/SG_A.SG_A" });
    expect(classifyLink("/Game/BP/BP_Door.BP_Door")).toEqual({ kind: "asset", path: "/Game/BP/BP_Door.BP_Door" });
  });

  it("is text for an Unreal path that names no asset", () => {
    expect(classifyLink("/Script/Engine.Actor")).toEqual({ kind: "none" });
    expect(classifyLink("/Game/A/B.uasset")).toEqual({ kind: "none" });
  });

  it("takes relative, absolute and file:// paths as project files", () => {
    expect(classifyLink(".wiki/Decisions.md")).toEqual({ kind: "file", path: ".wiki/Decisions.md" });
    expect(classifyLink("./Source/Vale/Vale.Build.cs")).toEqual({ kind: "file", path: "./Source/Vale/Vale.Build.cs" });
    expect(classifyLink("../README.md")).toEqual({ kind: "file", path: "../README.md" });
    expect(classifyLink("C:\\Users\\me\\Vale\\Notes.md")).toEqual({ kind: "file", path: "C:/Users/me/Vale/Notes.md" });
    expect(classifyLink("C:/Users/me/Vale/Notes.md")).toEqual({ kind: "file", path: "C:/Users/me/Vale/Notes.md" });
    expect(classifyLink("/home/me/vale/notes.md")).toEqual({ kind: "file", path: "/home/me/vale/notes.md" });
    expect(classifyLink("file:///C:/Users/me/Vale/My%20Notes.md")).toEqual({ kind: "file", path: "C:/Users/me/Vale/My Notes.md" });
    expect(classifyLink("file:///home/me/notes.md")).toEqual({ kind: "file", path: "/home/me/notes.md" });
    expect(classifyLink("file://localhost/home/me/notes.md")).toEqual({ kind: "file", path: "/home/me/notes.md" });
    expect(classifyLink("~/.claude/CLAUDE.md")).toEqual({ kind: "file", path: "~/.claude/CLAUDE.md" });
    expect(classifyLink("My%20Notes.md")).toEqual({ kind: "file", path: "My Notes.md" });
  });

  it("reads a #L12 or :12 line suffix, and drops other anchors", () => {
    expect(classifyLink("Source/Door.cpp#L12")).toEqual({ kind: "file", path: "Source/Door.cpp", line: 12 });
    expect(classifyLink("Source/Door.cpp#L12-L20")).toEqual({ kind: "file", path: "Source/Door.cpp", line: 12 });
    expect(classifyLink("Source/Door.cpp:12")).toEqual({ kind: "file", path: "Source/Door.cpp", line: 12 });
    expect(classifyLink("Source/Door.cpp:12:5")).toEqual({ kind: "file", path: "Source/Door.cpp", line: 12 });
    expect(classifyLink("C:/Vale/Door.cpp:7")).toEqual({ kind: "file", path: "C:/Vale/Door.cpp", line: 7 });
    expect(classifyLink(".wiki/Decisions.md#pcg")).toEqual({ kind: "file", path: ".wiki/Decisions.md" });
    expect(classifyLink("Door.cpp:12")).toEqual({ kind: "file", path: "Door.cpp", line: 12 });
    expect(classifyLink("Door.cpp:0")).toEqual({ kind: "file", path: "Door.cpp" });
  });

  it("is none for anything else, so nothing renders as a dead link", () => {
    for (const url of ["", "   ", "#top", "?q=1", "javascript:alert(1)", "vscode://file/C:/x.md", "data:text/html,x", "//evil.example/x", "\\\\server\\share\\x.md", "file://server/share/x.md", "ftp://example.com/x", null, undefined]) {
      expect(classifyLink(url), String(url)).toEqual({ kind: "none" });
    }
  });
});

describe("resolveFileLink", () => {
  it("resolves a link against the folder of the file it is in", () => {
    expect(resolveFileLink(".wiki/Index.md", "Decisions.md")).toBe(".wiki/Decisions.md");
    expect(resolveFileLink(".wiki/sub/Index.md", "../Decisions.md")).toBe(".wiki/Decisions.md");
    expect(resolveFileLink(".wiki/Index.md", "./a/./b.md")).toBe(".wiki/a/b.md");
    expect(resolveFileLink("README.md", "docs/a.md")).toBe("docs/a.md");
    expect(resolveFileLink("~/.claude/CLAUDE.md", "rules/x.md")).toBe("~/.claude/rules/x.md");
    expect(resolveFileLink("C:/Vale/Docs/A.md", "../B.md")).toBe("C:/Vale/B.md");
  });

  it("leaves absolute and home paths as they are, and a link from the chat unchanged", () => {
    expect(resolveFileLink(".wiki/Index.md", "C:/Vale/B.md")).toBe("C:/Vale/B.md");
    expect(resolveFileLink(".wiki/Index.md", "/home/me/b.md")).toBe("/home/me/b.md");
    expect(resolveFileLink(".wiki/Index.md", "~/.codex/AGENTS.md")).toBe("~/.codex/AGENTS.md");
    expect(resolveFileLink(undefined, ".wiki/Decisions.md")).toBe(".wiki/Decisions.md");
  });

  it("keeps .. steps it cannot fold, for the agent to refuse", () => {
    expect(normalizeFile("../../secret.txt")).toBe("../../secret.txt");
    expect(resolveFileLink("README.md", "../secret.txt")).toBe("../secret.txt");
    expect(normalizeFile("~/../secret.txt")).toBe("~/../secret.txt");
    expect(normalizeFile("/a/../../etc/passwd")).toBe("/etc/passwd");
  });
});

/** The reply's tree after the plugin, as [type, text, properties] for each paragraph child. */
function marks(markdown: string): Array<[string, string, Record<string, unknown>?]> {
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkReplyLinks);
  const tree = p.runSync(p.parse(markdown)) as unknown as MdNode;
  const text = (n: MdNode): string => n.value ?? (n.children ?? []).map(text).join("");
  return (tree.children?.[0]?.children ?? []).map((n) => {
    const props = n.data?.hProperties as Record<string, unknown> | undefined;
    return props ? [n.type, text(n), props] : [n.type, text(n)];
  });
}

describe("remarkReplyLinks", () => {
  it("marks each link as its kind: web stays a link, asset and file get their marks, none is text", () => {
    expect(marks("[docs](https://ue-mcp.com) [door](/Game/BP/BP_Door) [.wiki/Decisions.md](.wiki/Decisions.md) [run](javascript:alert(1))")).toEqual([
      ["link", "docs"],
      ["text", " "],
      ["assetLink", "door", { "data-asset-path": "/Game/BP/BP_Door.BP_Door", "data-asset-label": "door" }],
      ["text", " "],
      ["fileLink", ".wiki/Decisions.md", { "data-file-path": ".wiki/Decisions.md" }],
      ["text", " "],
      ["text", "run"],
    ]);
  });

  it("carries a file link's line, and keeps the link's own formatting", () => {
    expect(marks("[`Door.cpp`](Source/Door.cpp#L40)")).toEqual([["fileLink", "Door.cpp", { "data-file-path": "Source/Door.cpp", "data-file-line": "40" }]]);
  });
});

const file = (path: string, text = "x"): FileReadResponse => ({ path, text, size: text.length });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FileViewer", () => {
  it("opens a file, follows a link in it relative to that file, and goes back", async () => {
    const asked: string[] = [];
    const v = new FileViewer(async (p) => (asked.push(p), file(p, `# ${p}`)));
    v.open({ path: ".wiki/Index.md" });
    expect(v.state().view).toMatchObject({ status: "loading", request: { path: ".wiki/Index.md" } });
    await tick();
    expect(v.state()).toMatchObject({ view: { status: "ready", markdown: true, file: { path: ".wiki/Index.md" } }, canGoBack: false });
    v.open({ path: "Decisions.md", line: 3 }, ".wiki/Index.md");
    await tick();
    expect(v.state()).toMatchObject({ view: { status: "ready", request: { path: ".wiki/Decisions.md", line: 3 } }, canGoBack: true });
    v.back();
    expect(v.state().view).toMatchObject({ file: { path: ".wiki/Index.md" } });
    v.close();
    expect(v.state()).toEqual({ view: null, canGoBack: false });
    expect(asked).toEqual([".wiki/Index.md", ".wiki/Decisions.md"]);
  });

  it("shows the agent's message when a read fails, and a link from the chat starts over", async () => {
    const v = new FileViewer(async (p) => {
      if (p === "gone.md") throw new Error("gone.md does not exist.");
      return file(p);
    });
    v.open({ path: "a.txt" });
    await tick();
    v.open({ path: "gone.md" });
    await tick();
    expect(v.state()).toEqual({ view: { status: "error", request: { path: "gone.md" }, error: "gone.md does not exist." }, canGoBack: false });
  });

  it("drops a read that answers after the viewer closed", async () => {
    let answer!: (f: FileReadResponse) => void;
    const v = new FileViewer(() => new Promise((r) => (answer = r)));
    let changes = 0;
    v.subscribe(() => changes++);
    v.open({ path: "a.md" });
    v.close();
    answer(file("a.md"));
    await tick();
    expect(v.state().view).toBeNull();
    expect(changes).toBe(2);
  });
});

describe("fileLines and studioApi.readFile", () => {
  it("numbers lines without an empty last one", () => {
    expect(fileLines("a\r\nb\n")).toEqual(["a", "b"]);
  });

  it("asks the agent with the path and the file it came from", async () => {
    const seen: string[] = [];
    const reply = (body: unknown): Reply => ({ status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode(JSON.stringify(body)); })() });
    const api = studioApi(async (m, p) => (seen.push(`${m} ${p}`), reply(file(".wiki/D.md"))));
    expect(await api.readFile("D.md", ".wiki/Index.md")).toEqual(file(".wiki/D.md"));
    await api.readFile(".wiki/D.md");
    expect(seen).toEqual(["GET /v1/ext/studio/files/read?path=D.md&from=.wiki%2FIndex.md", "GET /v1/ext/studio/files/read?path=.wiki%2FD.md"]);
  });
});
