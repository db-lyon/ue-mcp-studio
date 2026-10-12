/**
 * Keeping Studio current from the panel: the extension (this agent and its
 * UI) and the editor plugin, read against the release channel's latest.json.
 *
 * The extension updates through `ue-mcp extension install`, run in the background
 * because it restarts the daemon this agent lives in. The editor plugin
 * cannot replace itself while the editor has it loaded, but the daemon
 * outlives the editor: the zip for this engine is downloaded and checked
 * against its published SHA-256, unpacked beside the plugin, then the editor
 * is stopped, the folders are swapped (the old one kept until the swap is
 * done), and the editor is started again.
 */
import { spawn, execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MANIFEST_URL = process.env.UE_MCP_STUDIO_CHANNEL || "https://github.com/db-lyon/ue-mcp-studio/releases/latest/download/latest.json";
const PLUGIN = "UE_MCP_Studio";

export interface ReleaseManifest {
  version: string;
  url: string;
  sha256: string;
  /**
   * The editor plugin, under the release's own version. changedIn is the release
   * whose build it is: a release that only renames it asks for no editor restart.
   */
  plugin?: { version: string; changedIn?: string; files: Record<string, { url: string; sha256: string }> };
}

export interface UpdateStatus {
  studio: { installed: string; latest: string | null; available: boolean };
  plugin: {
    installed: string | null;
    latest: string | null;
    available: boolean;
    /** project: in the project's Plugins folder, which the panel can update. engine: installed with the engine. */
    location: "project" | "engine" | "none";
    engine: string | null;
  };
  error?: string;
}

export interface UpdaterHost {
  projectDir: string;
  editors(): Array<{ connected: boolean }>;
  editorOperation(op: "start" | "stop" | "restart" | "rebuild"): Promise<Record<string, unknown>>;
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
  ) {}

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
    try {
      return (JSON.parse(fs.readFileSync(path.join(this.pluginDir(), `${PLUGIN}.uplugin`), "utf-8")) as { VersionName?: string }).VersionName ?? null;
    } catch {
      return null;
    }
  }

  async manifest(): Promise<ReleaseManifest> {
    const res = await this.fetchImpl(MANIFEST_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the release channel answered ${res.status}`);
    return (await res.json()) as ReleaseManifest;
  }

  async check(): Promise<UpdateStatus> {
    const engine = this.engine();
    const installedPlugin = this.pluginVersion();
    const status: UpdateStatus = {
      studio: { installed: this.installedVersion, latest: null, available: false },
      plugin: { installed: installedPlugin, latest: null, available: false, location: installedPlugin ? "project" : "engine", engine },
    };
    try {
      const m = await this.manifest();
      status.studio.latest = m.version;
      status.studio.available = isNewer(m.version, this.installedVersion);
      if (m.plugin) {
        status.plugin.latest = m.plugin.version;
        status.plugin.available = !!installedPlugin && !!engine && !!m.plugin.files[engine] && isNewer(m.plugin.changedIn ?? m.plugin.version, installedPlugin);
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
  private async ueMcp(args: string[]): Promise<{ started: boolean; error?: string }> {
    const npx = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
    if (!fs.existsSync(npx)) return { started: false, error: "npx was not found beside Node" };
    const pkg = await this.manifest().then((m) => (m as ReleaseManifest & { ueMcp?: { package?: string } }).ueMcp?.package ?? "ue-mcp@beta", () => "ue-mcp@beta");
    runHidden([npx, "-y", pkg, ...args], this.host.projectDir);
    return { started: true };
  }

  /** Reinstall the extension from the channel through the newest ue-mcp; the install restarts the daemon on it. */
  async updateStudio(): Promise<{ started: boolean; error?: string }> {
    const uproject = this.uproject();
    if (!uproject) return { started: false, error: "could not find the project" };
    return this.ueMcp(["extension", "install", MANIFEST_URL, uproject]);
  }

  /** Restart the daemon on the newest ue-mcp, after an update installed it. */
  async restartDaemon(): Promise<{ started: boolean; error?: string }> {
    const uproject = this.uproject();
    if (!uproject) return { started: false, error: "could not find the project" };
    // Stop, then start: two ue-mcp runs in one background chain, so the stop does not take the start down with it.
    const npx = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
    const pkg = await this.manifest().then((m) => (m as ReleaseManifest & { ueMcp?: { package?: string } }).ueMcp?.package ?? "ue-mcp@beta", () => "ue-mcp@beta");
    const script = `const {execFileSync}=require("child_process");const a=[${JSON.stringify(npx)},"-y",${JSON.stringify(pkg)}];` +
      `try{execFileSync(process.execPath,[...a,"daemon","stop",${JSON.stringify(uproject)}],{stdio:"ignore"})}catch{}` +
      `execFileSync(process.execPath,[...a,"daemon","start",${JSON.stringify(uproject)}],{stdio:"ignore"});`;
    runHidden(["-e", script], this.host.projectDir);
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
      if (!fs.existsSync(path.join(target, `${PLUGIN}.uplugin`))) throw new Error("the Studio plugin is not in this project's Plugins folder; update it where it was installed");
      const engine = this.engine();
      const m = await this.manifest();
      const file = engine ? m.plugin?.files[engine] : undefined;
      if (!m.plugin || !file) throw new Error(`no Studio plugin for Unreal Engine ${engine ?? "(unknown)"} in the latest release`);
      this.step(`Downloading the plugin ${m.plugin.version} for Unreal Engine ${engine}`);
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
      if (notStarted) return { ok: false, version: m.plugin.version, error: `The plugin is updated to ${m.plugin.version}, but the editor did not start: ${notStarted}` };
      return { ok: true, version: m.plugin.version };
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
 * that has no window.
 */
export function runHidden(args: string[], cwd: string): void {
  const wrapper =
    'const c=require("child_process").spawn(process.execPath,JSON.parse(process.env.STUDIO_CHAIN),{stdio:"ignore",windowsHide:true});' +
    'c.on("exit",(x)=>process.exit(x??0));c.on("error",()=>process.exit(1));';
  spawn(process.execPath, ["-e", wrapper], { detached: true, stdio: "ignore", windowsHide: true, cwd, env: { ...process.env, STUDIO_CHAIN: JSON.stringify(args) } }).unref();
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
