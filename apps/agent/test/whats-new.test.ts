/** What's new: the versions an update brought, the notes chosen for them, and the GitHub cache behind them. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi, ExtensionHandler } from "ue-mcp/daemon";
import { NOTES_CACHE_FILE, ReleaseNotes, VERSIONS_FILE, noteBody, recordVersions, registerWhatsNew, selectNotes, whatsNew, type Release } from "../src/whats-new.js";

const rel = (version: string, body = `Notes for ${version}`): Release => ({ version, prerelease: version.includes("-"), body, url: `https://example.test/${version}`, publishedAt: "2026-11-01T00:00:00Z" });
const versions = (r: { entries: Array<{ version: string; available: boolean }> }) => r.entries.map((e) => `${e.version}${e.available ? "*" : ""}`);

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-wn-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("recordVersions", () => {
  const none = { studio: null, plugin: null, bridge: null, ueMcp: null };

  it("knows no previous version the first time, then keeps the one before each change", () => {
    const file = path.join(dir, VERSIONS_FILE);
    expect(recordVersions(file, { ...none, studio: "0.1.1" }).studio).toEqual({ current: "0.1.1", previous: null });
    expect(recordVersions(file, { ...none, studio: "0.1.1" }).studio).toEqual({ current: "0.1.1", previous: null });
    expect(recordVersions(file, { ...none, studio: "0.1.3" }).studio).toEqual({ current: "0.1.3", previous: "0.1.1" });
    // Reading again without a change keeps the previous version.
    expect(recordVersions(file, { ...none, studio: "0.1.3" }).studio).toEqual({ current: "0.1.3", previous: "0.1.1" });
    expect(recordVersions(file, { ...none, studio: "0.1.4" }).studio).toEqual({ current: "0.1.4", previous: "0.1.3" });
  });

  it("leaves a part that is not installed now as it was", () => {
    const file = path.join(dir, VERSIONS_FILE);
    recordVersions(file, { ...none, plugin: "0.1.2" });
    expect(recordVersions(file, none).plugin).toEqual({ current: "0.1.2", previous: null });
  });
});

describe("selectNotes", () => {
  const list = ["0.2.0", "0.2.0-beta.1", "0.1.9", "0.1.8", "0.1.8-beta.2", "0.1.7", "0.1.6"].map((v) => rel(v));

  it("takes every release after the previous version up to the installed one, newest first", () => {
    expect(versions(selectNotes(list, { installed: "0.1.8", previous: "0.1.6", channel: "stable" }))).toEqual(["0.2.0*", "0.1.9*", "0.1.8", "0.1.7"]);
  });

  it("marks what is newer than installed as available", () => {
    expect(versions(selectNotes(list, { installed: "0.1.9", previous: "0.1.8", channel: "stable" }))).toEqual(["0.2.0*", "0.1.9"]);
  });

  it("shows only the installed version's notes when no previous version is known", () => {
    expect(versions(selectNotes(list, { installed: "0.2.0", previous: null, channel: "stable" }))).toEqual(["0.2.0"]);
  });

  it("takes prereleases only on beta, but always the installed one", () => {
    expect(versions(selectNotes(list, { installed: "0.1.8", previous: "0.1.7", channel: "beta" }))).toEqual(["0.2.0*", "0.2.0-beta.1*", "0.1.9*", "0.1.8", "0.1.8-beta.2"]);
    expect(versions(selectNotes(list, { installed: "0.1.8-beta.2", previous: "0.1.7", channel: "stable" }))).toEqual(["0.2.0*", "0.1.9*", "0.1.8*", "0.1.8-beta.2"]);
  });

  it("ignores a previous version newer than the installed one (a move back)", () => {
    expect(versions(selectNotes(list, { installed: "0.2.0", previous: "0.2.1", channel: "stable" }))).toEqual(["0.2.0"]);
  });

  it("keeps a long range short and counts what it left out", () => {
    const r = selectNotes(list, { installed: "0.2.0", previous: "0.1.0", channel: "beta", max: 3 });
    expect(versions(r)).toEqual(["0.2.0", "0.2.0-beta.1", "0.1.9"]);
    expect(r.more).toBe(4);
  });

  it("drops a release body's front matter", () => {
    expect(noteBody("---\nheadline:\n  - A thing\n---\n\n## v1\n\nText")).toBe("## v1\n\nText");
    expect(noteBody("## v1\n\n---\n\nText")).toBe("## v1\n\n---\n\nText");
  });
});

describe("ReleaseNotes", () => {
  const answer = (tags: string[]) => new Response(JSON.stringify(tags.map((t) => ({ tag_name: `v${t}`, prerelease: t.includes("-"), draft: false, body: `about ${t}`, html_url: `https://github.com/x/releases/tag/v${t}`, published_at: "2026-11-01T00:00:00Z" }))), { status: 200 });

  it("asks GitHub once an hour, and asks again on refresh", async () => {
    let calls = 0;
    let now = 0;
    const notes = new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), (async () => (calls++, answer(["1.0.0"]))) as typeof fetch, () => now);
    expect((await notes.releases("o/r")).releases.map((r) => r.version)).toEqual(["1.0.0"]);
    await notes.releases("o/r");
    expect(calls).toBe(1);
    now += 3600_001;
    await notes.releases("o/r");
    expect(calls).toBe(2);
    await notes.releases("o/r", true);
    expect(calls).toBe(3);
  });

  it("answers from the cached copy when GitHub fails, and with the error when there is none", async () => {
    let fail = false;
    const notes = new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), (async () => (fail ? new Response("", { status: 503 }) : answer(["1.0.0"]))) as typeof fetch);
    expect((await notes.releases("o/r")).error).toBeUndefined();
    fail = true;
    expect(await notes.releases("o/r", true)).toMatchObject({ releases: [{ version: "1.0.0" }] });
    expect(await notes.releases("o/other", true)).toEqual({ releases: [], error: "GitHub answered 503" });
  });

  it("leaves drafts out", async () => {
    const body = JSON.stringify([{ tag_name: "v2.0.0", draft: true }, { tag_name: "v1.0.0", draft: false }]);
    const notes = new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), (async () => new Response(body, { status: 200 })) as typeof fetch);
    expect((await notes.releases("o/r")).releases.map((r) => r.version)).toEqual(["1.0.0"]);
  });
});

describe("whatsNew", () => {
  const repos: Record<string, string[]> = {
    "db-lyon/ue-mcp-studio": ["0.1.3", "0.1.2", "0.1.1"],
    "db-lyon/ue-mcp": ["1.4.2", "1.4.1"],
  };
  const fetchImpl = (async (url: string) => {
    const repo = /repos\/([^/]+\/[^/]+)\/releases/.exec(url)![1];
    if (!repos[repo]) return new Response("", { status: 500 });
    return new Response(JSON.stringify(repos[repo].map((t) => ({ tag_name: `v${t}`, body: `about ${t}`, html_url: `https://github.com/${repo}/releases/tag/v${t}` }))), { status: 200 });
  }) as unknown as typeof fetch;

  it("gives each installed part its notes or its error, in order, and leaves out what is not installed", async () => {
    let installed = { studio: "0.1.1", plugin: "0.1.0", bridge: "1.4.1", ueMcp: null as string | null };
    const deps = { dataDir: dir, installed: () => installed, channel: () => "stable" as const, notes: new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), fetchImpl) };
    await whatsNew(deps);
    installed = { ...installed, studio: "0.1.2" };
    const w = await whatsNew(deps);
    expect(w.components.map((c) => c.part)).toEqual(["studio", "plugin", "bridge"]);
    expect(w.components[0]).toMatchObject({ name: "Studio", installed: "0.1.2", previous: "0.1.1", releasesUrl: "https://github.com/db-lyon/ue-mcp-studio/releases" });
    expect(versions(w.components[0])).toEqual(["0.1.3*", "0.1.2"]);
    expect(w.components[1]).toMatchObject({ entries: [], error: "GitHub answered 500", releasesUrl: "https://github.com/db-lyon/ue-mcp-studio-plugin/releases" });
    expect(versions(w.components[2])).toEqual(["1.4.2*", "1.4.1"]);
  });

  it("serves GET /whats-new and records the installed versions as soon as it is registered", async () => {
    const routes = new Map<string, ExtensionHandler>();
    const api = { route: (m: string, p: string, h: ExtensionHandler) => routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
    registerWhatsNew(api, { dataDir: dir, installed: () => ({ studio: "0.1.3", plugin: null, bridge: null, ueMcp: null }), channel: () => "stable", notes: new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), fetchImpl) });
    expect(JSON.parse(fs.readFileSync(path.join(dir, VERSIONS_FILE), "utf-8")).studio).toEqual({ current: "0.1.3", previous: null });
    const res = (await routes.get("GET /whats-new")!({ method: "GET", path: "/whats-new", params: {}, query: {}, headers: {}, body: undefined })) as { body: { components: Array<{ part: string }> } };
    expect(res.body.components.map((c) => c.part)).toEqual(["studio"]);
  });
});
