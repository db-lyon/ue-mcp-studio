/** What's new: the releases newer than each installed part, and the GitHub cache behind them. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi, ExtensionHandler } from "ue-mcp/daemon";
import { NOTES_CACHE_FILE, ReleaseNotes, noteBody, registerWhatsNew, selectNotes, whatsNew, type Release } from "../src/whats-new.js";

const rel = (version: string, body = `Notes for ${version}`): Release => ({ version, prerelease: version.includes("-"), body, url: `https://example.test/${version}`, publishedAt: "2026-11-01T00:00:00Z" });
const versions = (r: { entries: Array<{ version: string; available: boolean }> }) => r.entries.map((e) => `${e.version}${e.available ? "" : " (not newer)"}`);

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-wn-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("selectNotes", () => {
  const list = ["0.2.0", "0.2.0-beta.1", "0.1.9", "0.1.8", "0.1.8-beta.2", "0.1.7", "0.1.6"].map((v) => rel(v));

  it("takes only the releases newer than the installed one, newest first: never the installed one or older", () => {
    expect(versions(selectNotes(list, { installed: "0.1.8", channel: "stable" }))).toEqual(["0.2.0", "0.1.9"]);
  });

  it("is empty when nothing is newer", () => {
    expect(selectNotes(list, { installed: "0.2.0", channel: "stable" })).toEqual({ entries: [], more: 0 });
    expect(selectNotes(list, { installed: "0.3.0", channel: "beta" })).toEqual({ entries: [], more: 0 });
  });

  it("takes prereleases only on beta", () => {
    expect(versions(selectNotes(list, { installed: "0.1.8", channel: "beta" }))).toEqual(["0.2.0", "0.2.0-beta.1", "0.1.9"]);
    // On stable, a beta installed sees the stable releases above it, never another beta.
    expect(versions(selectNotes(list, { installed: "0.1.8-beta.2", channel: "stable" }))).toEqual(["0.2.0", "0.1.9", "0.1.8"]);
  });

  it("keeps a long list short and counts what it left out", () => {
    const r = selectNotes(list, { installed: "0.1.0", channel: "beta", max: 3 });
    expect(versions(r)).toEqual(["0.2.0", "0.2.0-beta.1", "0.1.9"]);
    expect(r.more).toBe(4);
  });

  it("leaves out tags that are not versions", () => {
    expect(versions(selectNotes([rel("android-v0.2.0-36"), rel("0.1.9")], { installed: "0.1.8", channel: "beta" }))).toEqual(["0.1.9"]);
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

  it("reads again within the hour when the cached list lacks the installed version, once it is a minute old", async () => {
    let tags = ["1.0.0"];
    let calls = 0;
    let now = 0;
    const notes = new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), (async () => (calls++, answer(tags))) as typeof fetch, () => now);
    await notes.releases("o/r", false, ["1.0.0"]);
    tags = ["1.0.1", "1.0.0"];
    now += 30_000;
    expect((await notes.releases("o/r", false, ["1.0.1"])).releases.map((r) => r.version)).toEqual(["1.0.0"]);
    now += 31_000;
    expect((await notes.releases("o/r", false, ["1.0.1"])).releases.map((r) => r.version)).toEqual(["1.0.1", "1.0.0"]);
    expect(calls).toBe(2);
    // Complete now: the hour applies again.
    now += 120_000;
    await notes.releases("o/r", false, ["1.0.1"]);
    expect(calls).toBe(2);
  });

  it("reads further pages while a needed version is not in yet, as other tags fill the first", async () => {
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 100 }, (_, i) => ({ tag_name: `android-v0.2.0-${i}` })),
      "2": [{ tag_name: "v0.1.3" }, { tag_name: "v0.1.2" }],
    };
    const asked: string[] = [];
    const notes = new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), (async (url: string) => {
      const page = new URL(url).searchParams.get("page")!;
      asked.push(page);
      return new Response(JSON.stringify(pages[page] ?? []), { status: 200 });
    }) as unknown as typeof fetch);
    const r = await notes.releases("o/r", false, ["0.1.3"]);
    expect(asked).toEqual(["1", "2"]);
    expect(selectNotes(r.releases, { installed: "0.1.2", channel: "stable" }).entries.map((e) => e.version)).toEqual(["0.1.3"]);
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

  it("gives each installed part what is newer or its error, in order, and leaves out what is not installed", async () => {
    const installed = { studio: "0.1.1", plugin: "0.1.0", bridge: "1.4.1", ueMcp: "1.4.2" as string | null };
    const w = await whatsNew({ dataDir: dir, installed: () => installed, channel: () => "stable", notes: new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), fetchImpl) });
    expect(w.components.map((c) => c.part)).toEqual(["studio", "plugin", "bridge", "ueMcp"]);
    expect(w.components[0]).toMatchObject({ name: "Studio", installed: "0.1.1", releasesUrl: "https://github.com/db-lyon/ue-mcp-studio/releases" });
    expect(versions(w.components[0])).toEqual(["0.1.3", "0.1.2"]);
    expect(w.components[1]).toMatchObject({ entries: [], error: "GitHub answered 500", releasesUrl: "https://github.com/db-lyon/ue-mcp-studio-plugin/releases" });
    expect(versions(w.components[2])).toEqual(["1.4.2"]);
    // ue-mcp is on the newest: nothing newer, so the dialog shows no accordion for it.
    expect(w.components[3].entries).toEqual([]);
    expect(w.components[3].error).toBeUndefined();
  });

  it("serves GET /whats-new", async () => {
    const routes = new Map<string, ExtensionHandler>();
    const api = { route: (m: string, p: string, h: ExtensionHandler) => routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
    registerWhatsNew(api, { dataDir: dir, installed: () => ({ studio: "0.1.3", plugin: null, bridge: null, ueMcp: null }), channel: () => "stable", notes: new ReleaseNotes(path.join(dir, NOTES_CACHE_FILE), fetchImpl) });
    const res = (await routes.get("GET /whats-new")!({ method: "GET", path: "/whats-new", params: {}, query: {}, headers: {}, body: undefined })) as { body: { components: Array<{ part: string }> } };
    expect(res.body.components.map((c) => c.part)).toEqual(["studio"]);
  });
});
