/**
 * Keeping Studio current from the panel: the extension (this agent and its
 * UI) against Studio's latest.json, and the editor plugin, a package of its
 * own, against its channel's plugin.json.
 *
 * The extension updates through `ue-mcp extension install`, run in the background
 * because it restarts the daemon this agent lives in. The editor plugin
 * cannot replace itself while the editor has it loaded, but the daemon
 * outlives the editor: the zip for this engine is downloaded and checked
 * against its published SHA-256, unpacked beside the plugin, then the editor
 * is stopped, the folders are swapped (the old one kept until the swap is
 * done), and the editor is started again. A plugin installed from Fab is
 * never swapped: the Fab Library updates it.
 */
import { spawn, execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StudioPluginSource, StudioPluginUpdate } from "@ue-mcp-studio/shared";

export const MANIFEST_URL = process.env.UE_MCP_STUDIO_CHANNEL || "https://github.com/db-lyon/ue-mcp-studio/releases/latest/download/latest.json";
/** The editor plugin's own channel, when a Studio manifest does not name one. */
export const PLUGIN_MANIFEST_URL = process.env.UE_MCP_STUDIO_PLUGIN_CHANNEL || "https://github.com/db-lyon/ue-mcp-studio-plugin/releases/latest/download/plugin.json";
const PLUGIN = "UE_MCP_Studio";
const STUDIO_REPO = "db-lyon/ue-mcp-studio";
const PLUGIN_REPO = "db-lyon/ue-mcp-studio-plugin";

/** stable follows each repo's latest release; beta also takes prereleases. */
export type UpdateChannel = "stable" | "beta";

/** The user's choice, kept for every project. */
export function channelFile(): string {
  return process.env.STUDIO_CHANNEL_FILE || path.join(os.homedir(), ".ue-mcp", "studio", "update-channel.json");
}

export function readChannel(file = channelFile()): UpdateChannel {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf-8")) as { channel?: string }).channel === "beta" ? "beta" : "stable";
  } catch {
    return "stable";
  }
}

export function writeChannel(channel: UpdateChannel, file = channelFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ channel }, null, 2) + "\n");
}

/**
 * The newest release of `repo` carrying `asset`, prereleases included, as a
 * download URL. GitHub has no "latest prerelease" address, so the list is read.
 */
export async function newestAsset(repo: string, asset: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}'s releases`);
  const releases = (await res.json()) as Array<{ tag_name: string; draft: boolean; assets: Array<{ name: string }> }>;
  let best: string | null = null;
  for (const r of releases) {
    if (r.draft || !r.assets.some((a) => a.name === asset)) continue;
    const v = r.tag_name.replace(/^v/, "");
    if (!best || isNewer(v, best)) best = v;
  }
  if (!best) throw new Error(`no release of ${repo} carries ${asset}`);
  return `https://github.com/${repo}/releases/download/v${best}/${asset}`;
}

export interface ReleaseManifest {
  version: string;
  url: string;
  sha256: string;
  /** Where the editor plugin's manifest is; the plugin is released on its own. */
  pluginChannel?: string;
  /** The oldest editor plugin this Studio works with. */
  pluginMin?: string;
}

/** plugin.json on the editor plugin's channel: its version and a zip per engine. */
export interface PluginManifest {
  version: string;
  files: Record<string, { url: string; sha256: string }>;
}

export interface UpdateStatus {
  channel: UpdateChannel;
  studio: { installed: string; latest: string | null; available: boolean };
  plugin: StudioPluginUpdate & { newer: boolean; required: boolean; source: StudioPluginSource };
  /** The step this daemon is running now, so a page that loads meanwhile waits for it. */
  running?: string;
  error?: string;
}

export interface UpdaterHost {
  projectDir: string;
  editors(): Array<{ connected: boolean }>;
  editorOperation(op: "start" | "stop" | "restart" | "rebuild"): Promise<Record<string, unknown>>;
}

/** The editor plugin the project loads, and where it came from. */
export interface InstalledPlugin {
  dir: string;
  version: string | null;
  location: "project" | "engine";
  source: StudioPluginSource;
  fabUrl?: string;
}

/** What the editor plugin writes to Saved/UE_MCP_Studio/plugin.json at startup. */
export function pluginRecordFile(projectDir: string): string {
  return path.join(projectDir, "Saved", PLUGIN, "plugin.json");
}

/**
 * The plugin as the editor last loaded it, from plugin.json; null when the
 * file is missing or malformed (plugins older than the record).
 */
export function readPluginRecord(projectDir: string): InstalledPlugin | null {
  let r: { version?: unknown; dir?: unknown; fab?: unknown; fabUrl?: unknown };
  try {
    r = JSON.parse(fs.readFileSync(pluginRecordFile(projectDir), "utf-8"));
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || typeof r.version !== "string" || typeof r.dir !== "string" || !r.dir || typeof r.fab !== "boolean") return null;
  const rel = path.relative(path.join(projectDir, "Plugins"), path.resolve(r.dir));
  const inProject = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const fabUrl = r.fab && typeof r.fabUrl === "string" && r.fabUrl.trim() ? r.fabUrl.trim() : undefined;
  return { dir: r.dir, version: r.version || null, location: inProject ? "project" : "engine", source: r.fab ? "fab" : "github", ...(fabUrl ? { fabUrl } : {}) };
}

/** The plugin in the project's Plugins folder, read from its .uplugin: a GitHub install. */
function readProjectPlugin(dir: string): InstalledPlugin | null {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(dir, `${PLUGIN}.uplugin`), "utf-8")) as { VersionName?: string };
    return { dir, version: u.VersionName ?? null, location: "project", source: "github" };
  } catch {
    return null;
  }
}

/** 0.1.0-beta.10 is newer than 0.1.0-beta.9: numbers compare as numbers, a release beats its prereleases. */
export function isNewer(a: string, b: string): boolean {
  const split = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) > (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) > Number(q);
    if (pn !== qn) return !pn;
    if (p !== q) return p > q;
  }
  return false;
}

/** npx-cli.js beside the Node running this daemon (UE_MCP_STUDIO_NPX names another), or null when there is none. */
function npxCli(): string | null {
  const npx = process.env.UE_MCP_STUDIO_NPX || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return fs.existsSync(npx) ? npx : null;
}

/**
 * The node arguments that run `pkg` through npx. npx applies the user's
 * min-release-age even to a package min-release-age-exclude names, which
 * npm install does not (ue-mcp#1510), so a release is refused on its first
 * days. These are ue-mcp's and Studio's own packages: the gate is lifted for them.
 */
export function npxArgs(npx: string, pkg: string): string[] {
  return [npx, "-y", "--min-release-age=0", pkg];
}

/**
 * What a failed npx run said, for the panel: npm's own error lines when it
 * wrote any, without the pointer to its log file, else the last lines written.
 */
export function failureText(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const npm = lines
    .filter((l) => /^npm (error|ERR!)/.test(l))
    .map((l) => l.replace(/^npm (error|ERR!)\s?/, ""))
    .filter((l) => l && !/^A complete log of this run|^\S*[\\/]_logs[\\/]/.test(l));
  return (npm.length ? npm : lines.slice(-5)).join("\n").slice(-2000);
}

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const tarExe = () => (process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar");

function unzip(zip: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) =>
    execFile(tarExe(), ["-xf", zip, "-C", dest], { windowsHide: true }, (err) => (err ? reject(new Error(`could not unpack the plugin: ${err.message}`)) : resolve())));
}

export class Updater {
  private busy: string | null = null;

  constructor(
    private readonly host: UpdaterHost,
    private readonly installedVersion: string,
    private readonly publish: (type: string, data: Record<string, unknown>) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly channel: () => UpdateChannel = () => readChannel(),
    /** A background run (the Studio update, the daemon restart) that failed while this daemon still runs. */
    private readonly onBackgroundFailure: (step: "studio" | "restart", error: string) => void = () => {},
  ) {}

  /** The ue-mcp package the manifest names, else the beta channel. */
  private async ueMcpPackage(): Promise<string> {
    return this.manifest().then((m) => (m as ReleaseManifest & { ueMcp?: { package?: string } }).ueMcp?.package ?? "ue-mcp@beta", () => "ue-mcp@beta");
  }

  /** Studio's latest.json on the chosen channel; UE_MCP_STUDIO_CHANNEL, when set, outranks the choice. */
  async manifestUrl(): Promise<string> {
    if (process.env.UE_MCP_STUDIO_CHANNEL || this.channel() !== "beta") return MANIFEST_URL;
    return newestAsset(STUDIO_REPO, "latest.json", this.fetchImpl);
  }

  private uproject(): string | null {
    const f = fs.readdirSync(this.host.projectDir).find((n) => n.endsWith(".uproject"));
    return f ? path.join(this.host.projectDir, f) : null;
  }

  /** The engine the project is on, as major.minor. */
  engine(): string | null {
    const p = this.uproject();
    if (!p) return null;
    try {
      const assoc = String((JSON.parse(fs.readFileSync(p, "utf-8")) as { EngineAssociation?: string }).EngineAssociation ?? "");
      const m = /^(\d+\.\d+)/.exec(assoc);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  private pluginDir(): string {
    return path.join(this.host.projectDir, "Plugins", PLUGIN);
  }

  /** The editor plugin's version in the project, or null when it is not in the project. */
  pluginVersion(): string | null {
    return readProjectPlugin(this.pluginDir())?.version ?? null;
  }

  /** The plugin's own record when it wrote one, else the project's .uplugin. */
  installedPlugin(): InstalledPlugin | null {
    return readPluginRecord(this.host.projectDir) ?? readProjectPlugin(this.pluginDir());
  }

  async manifest(): Promise<ReleaseManifest> {
    const res = await this.fetchImpl(await this.manifestUrl(), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the release channel answered ${res.status}`);
    return (await res.json()) as ReleaseManifest;
  }

  /** The editor plugin's manifest, or null when its channel has none yet. */
  async pluginManifest(m?: ReleaseManifest): Promise<PluginManifest | null> {
    const url = this.channel() === "beta" && !process.env.UE_MCP_STUDIO_PLUGIN_CHANNEL
      ? await newestAsset(PLUGIN_REPO, "plugin.json", this.fetchImpl)
      : m?.pluginChannel ?? PLUGIN_MANIFEST_URL;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the editor plugin's channel answered ${res.status}`);
    return (await res.json()) as PluginManifest;
  }

  async check(): Promise<UpdateStatus> {
    const engine = this.engine();
    const found = this.installedPlugin();
    const installedPlugin = found?.version ?? null;
    const status: UpdateStatus = {
      channel: this.channel(),
      ...(this.busy ? { running: this.busy } : {}),
      studio: { installed: this.installedVersion, latest: null, available: false },
      plugin: {
        installed: installedPlugin, latest: null, available: false, newer: false, location: found?.location ?? "engine", engine, required: false,
        source: found?.source ?? "github", ...(found?.fabUrl ? { fabUrl: found.fabUrl } : {}),
      },
    };
    // Only a project plugin from GitHub is swapped by Update.
    const swappable = found?.location === "project" && found.source === "github";
    try {
      const m = await this.manifest();
      status.studio.latest = m.version;
      status.studio.available = isNewer(m.version, this.installedVersion);
      status.plugin.required = !!installedPlugin && !!m.pluginMin && isNewer(m.pluginMin, installedPlugin);
      const p = await this.pluginManifest(m);
      if (p) {
        status.plugin.latest = p.version;
        status.plugin.newer = !!installedPlugin && isNewer(p.version, installedPlugin);
        status.plugin.available = status.plugin.newer && swappable && !!engine && !!p.files[engine];
      }
    } catch (e) {
      status.error = e instanceof Error ? e.message : String(e);
    }
    return status;
  }

  /**
   * Run the newest ue-mcp on the channel in the background: npx resolves the channel
   * (ue-mcp@beta) each time, so a daemon it starts runs the version just
   * installed rather than the one this daemon runs.
   */
  private async ueMcp(step: "studio", args: string[]): Promise<{ started: boolean; error?: string }> {
    const npx = npxCli();
    if (!npx) return { started: false, error: "npx was not found beside Node" };
    runHidden([...npxArgs(npx, await this.ueMcpPackage()), ...args], this.host.projectDir, (error) => this.onBackgroundFailure(step, error));
    return { started: true };
  }

  /** Reinstall the extension from the channel through the newest ue-mcp; the install restarts the daemon on it. */
  async updateStudio(): Promise<{ started: boolean; error?: string }> {
    // Restarting the daemon now would end the plugin swap halfway.
    if (this.busy) return { started: false, error: `an update is already running (${this.busy})` };
    const uproject = this.uproject();
    if (!uproject) return { started: false, error: "could not find the project" };
    return this.ueMcp("studio", ["extension", "install", await this.manifestUrl(), uproject]);
  }

  /**
   * Update a project whose bridge is installed from source: a daemon can only
   * deploy its own version's source, so the new package runs `ue-mcp update`
   * (package, then bridge source), and the editor is rebuilt on it.
   */
  async updateUeMcpSource(version: string): Promise<{ ok: boolean; error?: string }> {
    const uproject = this.uproject();
    if (!uproject) return { ok: false, error: "could not find the project" };
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) return { ok: false, error: `not a version: ${version}` };
    const npx = npxCli();
    if (!npx) return { ok: false, error: "npx was not found beside Node" };
    this.publish("update.progress", { part: "ueMcp", message: `Installing ue-mcp ${version} and its bridge source` });
    let stderr = "";
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [...npxArgs(npx, `ue-mcp@${version}`), "update", uproject, "--no-build"], { cwd: this.host.projectDir, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      c.stderr.setEncoding("utf-8");
      c.stderr.on("data", (d: string) => void (stderr = (stderr + d).slice(-64_000)));
      c.on("exit", resolve);
      c.on("error", (e) => {
        stderr += e.message;
        resolve(null);
      });
    });
    if (code !== 0) {
      const said = failureText(stderr);
      return { ok: false, error: `ue-mcp ${version} update exited with ${code ?? "an error"}${said ? `:\n${said}` : ""}` };
    }
    if (this.host.editors().some((e) => e.connected)) {
      this.publish("update.progress", { part: "ueMcp", message: "Rebuilding the editor on the new bridge" });
      await this.host.editorOperation("rebuild");
    }
    return { ok: true };
  }

  /** Restart the daemon on the newest ue-mcp, after an update installed it. */
  async restartDaemon(): Promise<{ started: boolean; error?: string }> {
    if (this.busy) return { started: false, error: `an update is already running (${this.busy})` };
    const uproject = this.uproject();
    if (!uproject) return { started: false, error: "could not find the project" };
    // Stop, then start: two ue-mcp runs in one background chain, so the stop does not take the start down with it.
    // The start's stderr is the chain's, which runHidden keeps for a failure this daemon outlives.
    const npx = npxCli();
    if (!npx) return { started: false, error: "npx was not found beside Node" };
    const script = `const {execFileSync}=require("child_process");const a=${JSON.stringify(npxArgs(npx, await this.ueMcpPackage()))};` +
      `try{execFileSync(process.execPath,[...a,"daemon","stop",${JSON.stringify(uproject)}],{stdio:"ignore",windowsHide:true})}catch{}` +
      `try{execFileSync(process.execPath,[...a,"daemon","start",${JSON.stringify(uproject)}],{stdio:["ignore","ignore","inherit"],windowsHide:true})}catch(e){process.exit(e.status||1)}`;
    runHidden(["-e", script], this.host.projectDir, (error) => this.onBackgroundFailure("restart", error));
    return { started: true };
  }

  private step(message: string): void {
    this.publish("update.progress", { part: "plugin", message });
  }

  /** Download, check, unpack, then stop the editor, swap the plugin folder and start the editor again. */
  async updatePlugin(): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (this.busy) return { ok: false, error: `an update is already running (${this.busy})` };
    this.busy = "plugin";
    const target = this.pluginDir();
    const staged = path.join(this.host.projectDir, "Plugins", `.${PLUGIN}.update`);
    const previous = path.join(this.host.projectDir, "Plugins", `.${PLUGIN}.previous`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-plugin-"));
    let swapped = false;
    try {
      if (readPluginRecord(this.host.projectDir)?.source === "fab") throw new Error("the Studio plugin was installed from Fab; update it from your Fab Library");
      if (!readProjectPlugin(target)) throw new Error("the Studio plugin is not in this project's Plugins folder; update it where it was installed");
      const engine = this.engine();
      const p = await this.pluginManifest(await this.manifest().catch(() => undefined));
      const file = engine ? p?.files[engine] : undefined;
      if (!p || !file) throw new Error(`no editor plugin for Unreal Engine ${engine ?? "(unknown)"} in the latest plugin release`);
      this.step(`Downloading the plugin ${p.version} for Unreal Engine ${engine}`);
      const res = await this.fetchImpl(file.url);
      if (!res.ok) throw new Error(`the download answered ${res.status}`);
      const zip = path.join(tmp, "plugin.zip");
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      if (sha256(zip) !== file.sha256.toLowerCase()) throw new Error("the download did not match its published SHA-256");
      this.step("Unpacking");
      fs.rmSync(staged, { recursive: true, force: true });
      await unzip(zip, staged);
      const unpacked = fs.existsSync(path.join(staged, PLUGIN, `${PLUGIN}.uplugin`)) ? path.join(staged, PLUGIN) : staged;
      if (!fs.existsSync(path.join(unpacked, `${PLUGIN}.uplugin`))) throw new Error("the download holds no Studio plugin");

      this.step("Closing the editor");
      if (this.host.editors().some((e) => e.connected)) await this.host.editorOperation("stop");
      this.step("Replacing the plugin");
      fs.rmSync(previous, { recursive: true, force: true });
      await retry(() => fs.renameSync(target, previous));
      swapped = true;
      await retry(() => fs.renameSync(unpacked, target));
      fs.rmSync(staged, { recursive: true, force: true });
      fs.rmSync(previous, { recursive: true, force: true });
      this.step("Starting the editor");
      const notStarted = await startFailure(this.host);
      if (notStarted) return { ok: false, version: p.version, error: `The plugin is updated to ${p.version}, but the editor did not start: ${notStarted}` };
      return { ok: true, version: p.version };
    } catch (e) {
      // Put the old plugin back if it was moved aside and the new one is not in place.
      if (swapped && !fs.existsSync(path.join(target, `${PLUGIN}.uplugin`)) && fs.existsSync(previous)) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(previous, target);
      }
      if (swapped) await this.host.editorOperation("start").catch(() => ({}));
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      this.busy = null;
    }
  }
}

/** Why starting the editor failed, or null when it started. */
async function startFailure(host: UpdaterHost): Promise<string | null> {
  try {
    const result = await host.editorOperation("start");
    const steps = (result.steps as Array<{ step: string; ok: boolean; result?: string }> | undefined) ?? [];
    const failed = steps.find((s) => !s.ok);
    if (failed) return `${failed.step}: ${failed.result ?? "failed"}`;
    return result.ok === false ? String(result.error ?? "failed") : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Run node in the background with no console window. npx runs ue-mcp under
 * cmd.exe, which opens a window of its own unless it inherits a console, and
 * a child that is not detached dies with this daemon, which the chain stops.
 * So a detached wrapper outlives the daemon and runs the chain in a console
 * that has no window. The chain's stderr goes to a file: when the chain fails
 * while this daemon still runs, `onFailure` gets what it said.
 */
export function runHidden(args: string[], cwd: string, onFailure?: (error: string) => void): void {
  const log = path.join(os.tmpdir(), `studio-update-${crypto.randomUUID()}.log`);
  const wrapper =
    'const fs=require("fs");const err=fs.openSync(process.env.STUDIO_CHAIN_LOG,"w");' +
    'const c=require("child_process").spawn(process.execPath,JSON.parse(process.env.STUDIO_CHAIN),{stdio:["ignore","ignore",err],windowsHide:true});' +
    'c.on("exit",(x)=>{fs.closeSync(err);if(!x)try{fs.rmSync(process.env.STUDIO_CHAIN_LOG,{force:true})}catch{}process.exit(x??0)});c.on("error",(e)=>{fs.writeSync(err,String(e.message));process.exit(1)});';
  const w = spawn(process.execPath, ["-e", wrapper], { detached: true, stdio: "ignore", windowsHide: true, cwd, env: { ...process.env, STUDIO_CHAIN: JSON.stringify(args), STUDIO_CHAIN_LOG: log } });
  w.on("exit", (code) => {
    let said = "";
    try {
      said = failureText(fs.readFileSync(log, "utf-8"));
    } catch {
      // No log: the wrapper did not start.
    }
    fs.rm(log, { force: true }, () => {});
    if (code !== 0) onFailure?.(said || `the update exited with ${code ?? "an error"}`);
  });
  w.on("error", (e) => onFailure?.(e.message));
  w.unref();
}

/** A file the editor just let go of can stay locked for a moment on Windows. */
async function retry(fn: () => void, tries = 20, delayMs = 500): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
