import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import {
  MENTION_ROWS,
  fileType,
  insertMention,
  mentionQuery,
  mentionToken,
  parseMentions,
  rankMentions,
  type MentionMatch,
} from "@ue-mcp-studio/shared";
import { LatestLane, MENTION_TTL_MS, MentionSearch, SUPERSEDED } from "../src/mentions.js";

const json = (v: unknown): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (text: string): ActionResult => ({ isError: true, content: [{ type: "text", text }] });
const PROJECT = path.resolve("/Projects/Game");

describe("the @name being typed", () => {
  it("is the text from @ to the caret, at the start or after a space", () => {
    expect(mentionQuery("@BP_Some", 8)).toEqual({ start: 0, end: 8, query: "BP_Some" });
    expect(mentionQuery("fix @BP_Some", 12)).toEqual({ start: 4, end: 12, query: "BP_Some" });
    expect(mentionQuery("fix @", 5)).toEqual({ start: 4, end: 5, query: "" });
    expect(mentionQuery("(@Door", 6)).toMatchObject({ start: 1, query: "Door" });
  });

  it("runs to the end of the name when the caret is inside it", () => {
    expect(mentionQuery("@BP_Door please", 3)).toEqual({ start: 0, end: 8, query: "BP" });
  });

  it("leaves e-mail addresses, finished names and written tokens alone", () => {
    expect(mentionQuery("me@example.com", 14)).toBeNull();
    expect(mentionQuery("@BP_Door ", 9)).toBeNull();
    expect(mentionQuery("plain text", 5)).toBeNull();
    expect(mentionQuery("[@BP_Door](/Game/BP_Door.BP_Door)", 8)).toBeNull();
  });

  it("narrows to one kind by a prefix", () => {
    expect(mentionQuery("@actor:Cube", 11)).toEqual({ start: 0, end: 11, query: "Cube", kinds: ["actor"] });
    expect(mentionQuery("@File:Default", 13)).toMatchObject({ query: "Default", kinds: ["file"] });
    expect(mentionQuery("@asset:", 7)).toMatchObject({ query: "", kinds: ["asset"] });
  });
});

const asset: MentionMatch = { kind: "asset", name: "BP_Door", type: "Blueprint", path: "/Game/Props/BP_Door.BP_Door", target: "/Game/Props/BP_Door.BP_Door" };
const actor: MentionMatch = { kind: "actor", name: "Front Door", type: "StaticMeshActor", path: "/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2", target: "actor:/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2" };
const file: MentionMatch = { kind: "file", name: "Door.cpp", type: "C++ source", path: "Source/Game/My Door/Door.cpp", target: "file:Source/Game/My Door/Door.cpp" };

describe("the token a mention leaves", () => {
  it("carries the full target and the type, readable as a markdown link", () => {
    expect(mentionToken(asset)).toBe('[@BP_Door](/Game/Props/BP_Door.BP_Door "Blueprint")');
    expect(mentionToken(actor)).toBe('[@Front Door](actor:/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2 "StaticMeshActor")');
    expect(mentionToken(file)).toBe('[@Door.cpp](<file:Source/Game/My Door/Door.cpp> "C++ source")');
  });

  it("reads back from a message as it was written, in order", () => {
    const text = `open ${mentionToken(asset)} and ${mentionToken(actor)} then ${mentionToken(file)}`;
    const spans = parseMentions(text);
    expect(spans.map((s) => [s.kind, s.name, s.type, s.path])).toEqual([
      ["asset", "BP_Door", "Blueprint", asset.path],
      ["actor", "Front Door", "StaticMeshActor", actor.path],
      ["file", "Door.cpp", "C++ source", file.path],
    ]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(mentionToken(asset));
  });

  it("never lets a name or a type break the token", () => {
    const t = mentionToken({ name: "Odd [label]", type: 'Say "hi"', target: "/Game/A.A" });
    expect(parseMentions(t)).toMatchObject([{ name: "Odd  label", type: "Say hi", path: "/Game/A.A" }]);
  });

  it("replaces the typed @name and puts the caret after it", () => {
    const text = "fix @BP_Do now";
    const q = mentionQuery(text, 10)!;
    const out = insertMention(text, q, asset);
    expect(out.text).toBe(`fix ${mentionToken(asset)} now`);
    expect(out.caret).toBe(`fix ${mentionToken(asset)} `.length);
    const end = insertMention("@BP", mentionQuery("@BP", 3)!, asset);
    expect(end.text).toBe(`${mentionToken(asset)} `);
    expect(end.caret).toBe(end.text.length);
  });
});

describe("ranking", () => {
  const m = (name: string, kind: MentionMatch["kind"] = "asset", p = `/Game/${name}.${name}`): MentionMatch => ({ kind, name, type: "", path: p, target: `${kind}:${p}` });

  it("puts an exact name first, then a name's start, a word's start, anywhere, and the path last", () => {
    const ranked = rankMentions("door", [m("BP_OldDoorway"), m("Door"), m("DoorFrame"), m("SM_Door_01"), m("Wall", "asset", "/Game/Door/Wall.Wall"), m("Indoors"), m("Rock")]);
    expect(ranked.map((x) => x.name)).toEqual(["Door", "DoorFrame", "SM_Door_01", "BP_OldDoorway", "Indoors", "Wall"]);
  });

  it("keeps one row per target and at most the row cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => m(`Door${i}`));
    expect(rankMentions("door", [...many, ...many])).toHaveLength(MENTION_ROWS);
  });

  it("names a file's type by its extension", () => {
    expect(["A.h", "A.cpp", "A.Build.cs", "DefaultGame.ini", "README", "notes.md"].map(fileType)).toEqual(["C++ header", "C++ source", "C# source", "Config", "File", "MD file"]);
  });
});

/** A project with an editor: asset.search, level.get_outliner, list_content_assets and list_files answered from lists. */
function project(o: { connected?: boolean; busy?: boolean; assetsFail?: boolean } = {}) {
  const assets = [
    { path: "/Game/Props/BP_Door", name: "BP_Door", className: "Blueprint" },
    { path: "/Game/Props/SM_Door", name: "SM_Door", className: "StaticMesh" },
    { path: "/Game/Maps/L_Doorway", name: "L_Doorway", className: "World" },
  ];
  const actors = [
    { label: "Front Door", name: "StaticMeshActor_2", class: "StaticMeshActor", path: "/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2" },
    { label: "Sun", name: "DirectionalLight_0", class: "DirectionalLight", path: "/Game/Maps/Main.Main:PersistentLevel.DirectionalLight_0" },
  ];
  const files: Record<string, string[]> = {
    Source: ["Source/Game/Door.cpp", "Source/Game/Door.h", "Source/Game/Game.Build.cs"],
    Config: ["Config/DefaultGame.ini"],
  };
  const has = (s: string, q: unknown) => s.toLowerCase().includes(String(q).toLowerCase());
  const callAction = vi.fn(async (category: string, action: string, args: Record<string, unknown> = {}): Promise<ActionResult> => {
    const key = `${category}.${action}`;
    if (key === "asset.search") {
      if (o.assetsFail) return fail("Editor not connected");
      return json({ results: assets.filter((a) => has(a.name, args.query) || has(a.path, args.query)) });
    }
    if (key === "level.get_outliner") return json({ actors: actors.filter((a) => has(a.label, args.nameFilter) || has(a.name, args.nameFilter)) });
    if (key === "project.list_content_assets") {
      return json({ assets: assets.filter((a) => has(a.name, args.namePattern)).map((a) => ({ assetPath: a.path, name: a.name, kind: a.className === "World" ? "map" : "asset" })) });
    }
    if (key === "project.list_files") {
      const dir = String(args.directory);
      const list = (files[dir] ?? []).filter((f) => args.namePattern === undefined || has(path.basename(f), args.namePattern));
      return json({ files: list.map((f) => ({ path: path.join(PROJECT, f), name: path.basename(f) })) });
    }
    return fail(`unexpected ${key}`);
  });
  let now = 0;
  const search = new MentionSearch({
    host: { callAction, projectDir: PROJECT },
    connected: () => o.connected ?? true,
    busy: () => o.busy ?? false,
    now: () => now,
  });
  return { search, callAction, tick: (ms: number) => (now += ms) };
}

const answer = async (s: MentionSearch, q: string, kinds?: MentionMatch["kind"][]) => {
  const r = await s.search(q, kinds);
  if (r === SUPERSEDED) throw new Error("superseded");
  return r;
};

describe("MentionSearch", () => {
  it("finds assets in the editor, actors in the open level and project files, ranked by name", async () => {
    const { search, callAction } = project();
    const r = await answer(search, "door");
    expect(r.sources).toEqual({ asset: "editor", actor: "editor", file: "disk" });
    expect(r.results.map((m) => [m.kind, m.name, m.type, m.target])).toEqual([
      ["file", "Door.h", "C++ header", "file:Source/Game/Door.h"],
      ["file", "Door.cpp", "C++ source", "file:Source/Game/Door.cpp"],
      ["asset", "BP_Door", "Blueprint", "/Game/Props/BP_Door.BP_Door"],
      ["asset", "SM_Door", "StaticMesh", "/Game/Props/SM_Door.SM_Door"],
      // Word starts both: the shorter name first.
      ["asset", "L_Doorway", "World", "/Game/Maps/L_Doorway.L_Doorway"],
      ["actor", "Front Door", "StaticMeshActor", "actor:/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2"],
    ]);
    // The lookups are ue-mcp actions, with the name sent to each.
    expect(callAction).toHaveBeenCalledWith("asset", "search", expect.objectContaining({ query: "door" }));
    expect(callAction).toHaveBeenCalledWith("level", "get_outliner", expect.objectContaining({ nameFilter: "door" }));
    expect(callAction).toHaveBeenCalledWith("project", "list_files", expect.objectContaining({ directory: "Source", recursive: true, namePattern: "door" }));
    expect(callAction).toHaveBeenCalledWith("project", "list_files", expect.objectContaining({ directory: "Config", namePattern: "door" }));
  });

  it("asks only the kinds a prefix names", async () => {
    const { search, callAction } = project();
    const r = await answer(search, "door", ["actor"]);
    expect(r.results.map((m) => m.name)).toEqual(["Front Door"]);
    expect(r.sources).toEqual({ actor: "editor" });
    expect(callAction.mock.calls.map((c) => `${c[0]}.${c[1]}`)).toEqual(["level.get_outliner"]);
  });

  it("reads assets from disk and says actors are unavailable with no editor", async () => {
    const { search, callAction } = project({ connected: false });
    const r = await answer(search, "door", ["asset", "actor"]);
    expect(r.sources).toEqual({ asset: "disk", actor: "unavailable" });
    expect(r.results.map((m) => [m.name, m.type])).toEqual([["BP_Door", "Asset"], ["SM_Door", "Asset"], ["L_Doorway", "Level"]]);
    expect(callAction.mock.calls.some((c) => c[0] === "asset" || c[0] === "level")).toBe(false);
  });

  it("leaves an editor busy with the agent's calls alone", async () => {
    const { search, callAction } = project({ busy: true });
    const r = await answer(search, "door", ["asset", "actor"]);
    expect(r.sources).toEqual({ asset: "disk", actor: "unavailable" });
    expect(callAction.mock.calls.some((c) => c[0] === "asset" || c[0] === "level")).toBe(false);
  });

  it("falls back to disk when the editor's asset search fails", async () => {
    const { search } = project({ assetsFail: true });
    const r = await answer(search, "door", ["asset"]);
    expect(r.sources).toEqual({ asset: "disk" });
    expect(r.results).toHaveLength(3);
  });

  it("answers an empty query with nothing and asks nobody", async () => {
    const { search, callAction } = project();
    expect(await answer(search, "  ")).toEqual({ query: "", results: [], sources: {} });
    expect(callAction).not.toHaveBeenCalled();
  });

  it("reuses an answer for a few seconds, and forgets it when told", async () => {
    const { search, callAction, tick } = project();
    await answer(search, "door");
    const calls = callAction.mock.calls.length;
    await answer(search, "DOOR");
    expect(callAction.mock.calls.length).toBe(calls);
    tick(MENTION_TTL_MS + 1);
    await answer(search, "door");
    expect(callAction.mock.calls.length).toBe(calls * 2);
    search.forget();
    await answer(search, "door");
    expect(callAction.mock.calls.length).toBe(calls * 3);
  });

  it("gives up on an editor that does not answer, and still answers from disk", async () => {
    const callAction = vi.fn(async (category: string, action: string): Promise<ActionResult> => {
      if (category === "asset" || category === "level") return new Promise(() => {});
      if (action === "list_content_assets") return json({ assets: [{ assetPath: "/Game/BP_Door", name: "BP_Door", kind: "asset" }] });
      return json({ files: [] });
    });
    const search = new MentionSearch({ host: { callAction, projectDir: PROJECT }, connected: () => true, busy: () => false, editorTimeoutMs: 20 });
    const r = await search.search("door");
    expect(r).not.toBe(SUPERSEDED);
    expect(r !== SUPERSEDED && r.sources).toEqual({ asset: "disk", actor: "unavailable", file: "disk" });
  });
});

describe("LatestLane", () => {
  it("runs one call at a time, and of the calls waiting only the newest", async () => {
    const lane = new LatestLane();
    let release!: () => void;
    const first = lane.run(() => new Promise<string>((r) => (release = () => r("first"))));
    const second = lane.run(async () => "second");
    const third = lane.run(async () => "third");
    expect(await second).toBe(SUPERSEDED);
    release();
    expect(await first).toBe("first");
    expect(await third).toBe("third");
  });
});
