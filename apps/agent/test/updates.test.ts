import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Updater, isNewer } from "../src/updates.js";

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
