import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Updater, isNewer, readPluginRecord, newestAsset, readChannel, writeChannel } from "../src/updates.js";

// The user's own channel choice never reaches these tests.
process.env.STUDIO_CHANNEL_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "studio-chan-")), "update-channel.json");

const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

function project(pluginVersion: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-upd-"));
  fs.writeFileSync(path.join(dir, "Game.uproject"), JSON.stringify({ EngineAssociation: "5.8" }));
  if (pluginVersion) {
    const p = path.join(dir, "Plugins", "UE_MCP_Studio");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "UE_MCP_Studio.uplugin"), JSON.stringify({ VersionName: pluginVersion }));
  }
  return dir;
}

/** The record the editor plugin writes at startup. */
function record(dir: string, r: unknown) {
  const file = path.join(dir, "Saved", "UE_MCP_Studio", "plugin.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof r === "string" ? r : JSON.stringify(r));
}

/** A release zip of the plugin, as release.mjs packages it. */
function pluginZip(version: string): { file: string; sha256: string } {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "studio-zip-"));
  fs.mkdirSync(path.join(stage, "UE_MCP_Studio"));
  fs.writeFileSync(path.join(stage, "UE_MCP_Studio", "UE_MCP_Studio.uplugin"), JSON.stringify({ VersionName: version }));
  const file = path.join(stage, "p.zip");
  execFileSync(tar, process.platform === "win32" ? ["-a", "-c", "-f", file, "-C", stage, "UE_MCP_Studio"] : ["-c", "-f", file, "-C", stage, "UE_MCP_Studio"]);
  return { file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}

function fakeHost(dir: string) {
  const ops: string[] = [];
  return {
    projectDir: dir,
    ops,
    editors: () => [{ connected: ops.lastIndexOf("stop") <= ops.lastIndexOf("start") }],
    editorOperation: async (op: "start" | "stop" | "restart" | "rebuild") => {
      ops.push(op);
      return {};
    },
  };
}

/** Studio's latest.json, and the plugin's own plugin.json (404 when `plugin` is absent), then the zip. */
const manifestFetch = (manifest: { plugin?: unknown } & Record<string, unknown>, zip?: Buffer) => (async (url: string) => {
  const { plugin, ...studio } = manifest;
  if (url.endsWith("latest.json")) return new Response(JSON.stringify(studio));
  if (url.endsWith("plugin.json")) return plugin ? new Response(JSON.stringify(plugin)) : new Response("Not Found", { status: 404 });
  return new Response(zip ?? Buffer.alloc(0));
}) as unknown as typeof fetch;

describe("Studio updates", () => {
  it("orders versions the way the channel numbers them", () => {
    expect(isNewer("0.1.0-beta.10", "0.1.0-beta.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0-beta.12")).toBe(true);
    expect(isNewer("0.1.0-beta.9", "0.1.0-beta.9")).toBe(false);
    expect(isNewer("0.1.0-beta.2", "0.1.1-beta.1")).toBe(false);
  });

  it("says what is newer for Studio and for the plugin on this project's engine", async () => {
    const dir = project("0.1.0-beta.4");
    const u = new Updater(fakeHost(dir), "0.1.0-beta.9", () => {}, manifestFetch({
      version: "0.1.0-beta.10", url: "studio.zip", sha256: "x",
      plugin: { version: "0.1.0-beta.9", files: { "5.8": { url: "https://x/p.zip", sha256: "y" } } },
    }));
    expect(await u.check()).toMatchObject({
      studio: { installed: "0.1.0-beta.9", latest: "0.1.0-beta.10", available: true },
      plugin: { installed: "0.1.0-beta.4", latest: "0.1.0-beta.9", available: true, location: "project", engine: "5.8" },
    });
  });

  it("reads the plugin from its own channel, and says when the installed one is older than Studio needs", async () => {
    const m = { version: "0.1.0-beta.27", url: "s", sha256: "x", pluginMin: "0.1.0-beta.27", plugin: { version: "0.1.0-beta.27", files: { "5.8": { url: "u", sha256: "y" } } } };
    expect((await new Updater(fakeHost(project("0.1.0-beta.26")), "0.1.0-beta.26", () => {}, manifestFetch(m)).check()).plugin).toMatchObject({ latest: "0.1.0-beta.27", available: true, required: true });
    expect((await new Updater(fakeHost(project("0.1.0-beta.27")), "0.1.0-beta.26", () => {}, manifestFetch(m)).check()).plugin).toMatchObject({ available: false, required: false });
  });

  it("passes on the oldest ue-mcp the latest Studio runs on", async () => {
    const m = { version: "0.1.0-beta.27", url: "s", sha256: "x", ueMcp: { min: "1.4.11-beta.6", package: "ue-mcp@beta" } };
    expect((await new Updater(fakeHost(project("0.1.0-beta.26")), "0.1.0-beta.26", () => {}, manifestFetch(m)).check()).ueMcpMin).toBe("1.4.11-beta.6");
  });

  it("offers no plugin update while the plugin's channel has no release", async () => {
    const status = await new Updater(fakeHost(project("0.1.0-beta.11")), "0.1.0-beta.26", () => {}, manifestFetch({ version: "0.1.0-beta.27", url: "s", sha256: "x" })).check();
    expect(status.error).toBeUndefined();
    expect(status.plugin).toMatchObject({ latest: null, available: false });
    expect(status.studio.available).toBe(true);
  });

  it("does not offer a plugin update for an engine the release does not build, or a plugin installed with the engine", async () => {
    const m = { version: "0.1.0-beta.9", url: "s", sha256: "x", plugin: { version: "0.1.0-beta.9", files: { "5.7": { url: "u", sha256: "y" } } } };
    expect((await new Updater(fakeHost(project("0.1.0-beta.4")), "0.1.0-beta.9", () => {}, manifestFetch(m)).check()).plugin.available).toBe(false);
    expect((await new Updater(fakeHost(project(null)), "0.1.0-beta.9", () => {}, manifestFetch(m)).check()).plugin).toMatchObject({ location: "engine", available: false });
  });

  it("swaps the plugin while the editor is stopped, then starts it again", async () => {
    const dir = project("0.1.0-beta.4");
    const zip = pluginZip("0.1.0-beta.9");
    const host = fakeHost(dir);
    const steps: string[] = [];
    const u = new Updater(host, "0.1.0-beta.9", (_t, d) => steps.push(String(d.message)), manifestFetch({
      version: "0.1.0-beta.9", url: "s", sha256: "x",
      plugin: { version: "0.1.0-beta.9", files: { "5.8": { url: "https://x/p.zip", sha256: zip.sha256 } } },
    }, fs.readFileSync(zip.file)));
    expect(await u.updatePlugin()).toEqual({ ok: true, version: "0.1.0-beta.9" });
    expect(host.ops).toEqual(["stop", "start"]);
    expect(u.pluginVersion()).toBe("0.1.0-beta.9");
    expect(fs.readdirSync(path.join(dir, "Plugins"))).toEqual(["UE_MCP_Studio"]);
    expect(steps[0]).toMatch(/Downloading/);
  });

  it("leaves the plugin alone when the editor does not close, rather than swapping under it", async () => {
    const dir = project("0.1.0-beta.4");
    const zip = pluginZip("0.1.0-beta.9");
    const ops: string[] = [];
    const host = {
      ...fakeHost(dir),
      editorOperation: async (op: string) => (ops.push(op), op === "stop" ? { steps: [{ step: "editor.stop_editor", ok: false, result: "a modal dialog is open" }] } : {}),
    };
    const u = new Updater(host, "0.1.0-beta.9", () => {}, manifestFetch({
      version: "0.1.0-beta.9", url: "s", sha256: "x",
      plugin: { version: "0.1.0-beta.9", files: { "5.8": { url: "https://x/p.zip", sha256: zip.sha256 } } },
    }, fs.readFileSync(zip.file)));
    expect(await u.updatePlugin()).toEqual({ ok: false, error: "the editor did not close (editor.stop_editor: a modal dialog is open), so the plugin was left as it is" });
    expect(ops).toEqual(["stop"]);
    expect(u.pluginVersion()).toBe("0.1.0-beta.4");
  });

  it("stages outside Plugins/ and clears the copies an earlier updater left there", async () => {
    const dir = project("0.1.0-beta.4");
    for (const spare of [".UE_MCP_Studio.update", ".UE_MCP_Studio.previous"]) {
      fs.mkdirSync(path.join(dir, "Plugins", spare), { recursive: true });
      fs.writeFileSync(path.join(dir, "Plugins", spare, "UE_MCP_Studio.uplugin"), "{}");
    }
    const zip = pluginZip("0.1.0-beta.9");
    const seen: string[][] = [];
    const host = { ...fakeHost(dir), editorOperation: async (op: string) => (op === "stop" && seen.push(fs.readdirSync(path.join(dir, "Plugins")).sort()), {}) };
    const u = new Updater(host, "0.1.0-beta.9", () => {}, manifestFetch({
      version: "0.1.0-beta.9", url: "s", sha256: "x",
      plugin: { version: "0.1.0-beta.9", files: { "5.8": { url: "https://x/p.zip", sha256: zip.sha256 } } },
    }, fs.readFileSync(zip.file)));
    expect(await u.updatePlugin()).toEqual({ ok: true, version: "0.1.0-beta.9" });
    // While the new plugin waited to go in, Plugins/ held one Studio plugin.
    expect(seen).toEqual([["UE_MCP_Studio"]]);
    expect(fs.readdirSync(path.join(dir, "Plugins"))).toEqual(["UE_MCP_Studio"]);
    expect(fs.existsSync(path.join(dir, "Intermediate", "UE_MCP_Studio_Update"))).toBe(false);
  });

  it("says so when the plugin is in place but the editor does not start", async () => {
    const dir = project("0.1.0-beta.4");
    const zip = pluginZip("0.1.0-beta.9");
    const host = { ...fakeHost(dir), editorOperation: async (op: string) => (op === "start" ? { steps: [{ step: "wait for the editor", ok: false, result: "did not become ready in 300s" }] } : {}) };
    const u = new Updater(host, "0.1.0-beta.9", () => {}, manifestFetch({
      version: "0.1.0-beta.9", url: "s", sha256: "x",
      plugin: { version: "0.1.0-beta.9", files: { "5.8": { url: "https://x/p.zip", sha256: zip.sha256 } } },
    }, fs.readFileSync(zip.file)));
    expect(await u.updatePlugin()).toEqual({ ok: false, version: "0.1.0-beta.9", error: "The plugin is updated to 0.1.0-beta.9, but the editor did not start: wait for the editor: did not become ready in 300s" });
    expect(u.pluginVersion()).toBe("0.1.0-beta.9");
  });

  it("refuses to restart the daemon while the plugin swap runs, and says it is running", async () => {
    const dir = project("0.1.0-beta.4");
    const zip = pluginZip("0.1.0-beta.9");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const host = { ...fakeHost(dir), editorOperation: async (op: "start" | "stop" | "restart" | "rebuild") => (op === "stop" ? held.then(() => ({})) : {}) };
    const u = new Updater(host, "0.1.0-beta.9", () => {}, manifestFetch({
      version: "0.1.0-beta.10", url: "s", sha256: "x",
      plugin: { version: "0.1.0-beta.9", files: { "5.8": { url: "https://x/p.zip", sha256: zip.sha256 } } },
    }, fs.readFileSync(zip.file)));
    const swap = u.updatePlugin();
    await new Promise((r) => setTimeout(r, 300));
    expect((await u.check()).running).toBe("plugin");
    expect(await u.updateStudio()).toEqual({ started: false, error: "an update is already running (plugin)" });
    expect(await u.restartDaemon()).toEqual({ started: false, error: "an update is already running (plugin)" });
    release();
    expect(await swap).toEqual({ ok: true, version: "0.1.0-beta.9" });
    expect((await u.check()).running).toBeUndefined();
  });

  it("refuses a download whose SHA-256 does not match, and leaves the plugin and the editor alone", async () => {
    const dir = project("0.1.0-beta.4");
    const zip = pluginZip("0.1.0-beta.9");
    const host = fakeHost(dir);
    const u = new Updater(host, "0.1.0-beta.9", () => {}, manifestFetch({
      version: "0.1.0-beta.9", url: "s", sha256: "x",
      plugin: { version: "0.1.0-beta.9", files: { "5.8": { url: "https://x/p.zip", sha256: "0".repeat(64) } } },
    }, fs.readFileSync(zip.file)));
    expect(await u.updatePlugin()).toMatchObject({ ok: false, error: expect.stringMatching(/SHA-256/) });
    expect(host.ops).toEqual([]);
    expect(u.pluginVersion()).toBe("0.1.0-beta.4");
  });
});

describe("the plugin's own record", () => {
  const m = { version: "0.1.9", url: "s", sha256: "x", pluginMin: "0.1.9", plugin: { version: "0.1.9", files: { "5.8": { url: "https://x/p.zip", sha256: "y" } } } };

  it("marks a Fab install, wherever it is, and shows the newer version without offering it to Update", async () => {
    const url = "com.epicgames.launcher://ue/Fab/product/abc";
    const dir = project(null);
    record(dir, { version: "0.1.8", dir: path.join(os.tmpdir(), "anywhere", "UE_MCP_Studio"), fab: true, fabUrl: url });
    const status = await new Updater(fakeHost(dir), "0.1.9", () => {}, manifestFetch(m)).check();
    expect(status.plugin).toMatchObject({ installed: "0.1.8", latest: "0.1.9", available: false, newer: true, required: true, location: "engine", source: "fab", fabUrl: url });
  });

  it("never swaps a Fab install in the project's Plugins folder", async () => {
    const dir = project("0.1.8");
    record(dir, { version: "0.1.8", dir: path.join(dir, "Plugins", "UE_MCP_Studio"), fab: true, fabUrl: "" });
    const host = fakeHost(dir);
    const u = new Updater(host, "0.1.9", () => {}, manifestFetch(m));
    const status = await u.check();
    expect(status.plugin).toMatchObject({ available: false, newer: true, location: "project", source: "fab" });
    expect(status.plugin.fabUrl).toBeUndefined();
    expect(await u.updatePlugin()).toMatchObject({ ok: false, error: expect.stringMatching(/Fab Library/) });
    expect(host.ops).toEqual([]);
    expect(u.pluginVersion()).toBe("0.1.8");
  });

  it("takes fab false as a GitHub install, which Update keeps current", async () => {
    const dir = project("0.1.8");
    record(dir, { version: "0.1.8", dir: path.join(dir, "Plugins", "UE_MCP_Studio"), fab: false, fabUrl: "" });
    expect((await new Updater(fakeHost(dir), "0.1.9", () => {}, manifestFetch(m)).check()).plugin).toMatchObject({ installed: "0.1.8", available: true, location: "project", source: "github" });
  });

  it("falls back to the project's .uplugin as a GitHub install when the record is missing or malformed", async () => {
    expect(readPluginRecord(project("0.1.8"))).toBeNull();
    expect((await new Updater(fakeHost(project("0.1.8")), "0.1.9", () => {}, manifestFetch(m)).check()).plugin).toMatchObject({ installed: "0.1.8", available: true, source: "github" });
    for (const bad of ["{not json", JSON.stringify({ version: "0.1.8", dir: "x" }), JSON.stringify({ version: 8, dir: "x", fab: true })]) {
      const dir = project("0.1.8");
      record(dir, bad);
      expect(readPluginRecord(dir)).toBeNull();
      expect((await new Updater(fakeHost(dir), "0.1.9", () => {}, manifestFetch(m)).check()).plugin).toMatchObject({ installed: "0.1.8", available: true, location: "project", source: "github" });
    }
  });
});

describe("the update channel", () => {
  const releases = (repo: string) => [
    { tag_name: "v0.1.1", draft: false, assets: [{ name: repo.endsWith("plugin") ? "plugin.json" : "latest.json" }] },
    { tag_name: "v0.1.2-beta.17", draft: false, assets: [{ name: repo.endsWith("plugin") ? "plugin.json" : "latest.json" }] },
    { tag_name: "v0.1.2-beta.18", draft: true, assets: [{ name: "latest.json" }, { name: "plugin.json" }] },
    { tag_name: "v0.1.2-beta.9", draft: false, assets: [{ name: "latest.json" }, { name: "plugin.json" }] },
  ];
  const seen: string[] = [];
  const github = (async (url: string) => {
    seen.push(url);
    const m = /repos\/([^/]+\/[^/]+)\/releases/.exec(url);
    if (m) return new Response(JSON.stringify(releases(m[1])));
    if (url.endsWith("latest.json")) return new Response(JSON.stringify({ version: /v([^/]+)\/latest\.json$/.exec(url)?.[1] ?? "0.1.1", url: "s", sha256: "x" }));
    if (url.endsWith("plugin.json")) return new Response(JSON.stringify({ version: /v([^/]+)\/plugin\.json$/.exec(url)?.[1] ?? "0.1.0", files: { "5.8": { url: "z", sha256: "x" } } }));
    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof fetch;

  it("is stable until the user picks beta, and keeps the choice", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "studio-chan-")), "c.json");
    expect(readChannel(file)).toBe("stable");
    writeChannel("beta", file);
    expect(readChannel(file)).toBe("beta");
  });

  it("finds the newest published release, prereleases included, drafts not", async () => {
    expect(await newestAsset("db-lyon/ue-mcp-studio", "latest.json", github)).toBe("https://github.com/db-lyon/ue-mcp-studio/releases/download/v0.1.2-beta.17/latest.json");
  });

  it("offers the betas of Studio and the plugin on beta, and only stable releases on stable", async () => {
    const beta = await new Updater(fakeHost(project("0.1.0")), "0.1.1", () => {}, github, () => "beta").check();
    expect(beta).toMatchObject({ channel: "beta", studio: { latest: "0.1.2-beta.17", available: true }, plugin: { latest: "0.1.2-beta.17", available: true } });
    seen.length = 0;
    const stable = await new Updater(fakeHost(project("0.1.0")), "0.1.2-beta.17", () => {}, github, () => "stable").check();
    expect(seen.some((u) => u.includes("api.github.com"))).toBe(false);
    // Going back to stable never offers an older version over a beta.
    expect(stable.studio.available).toBe(false);
  });
});
