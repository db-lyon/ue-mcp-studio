/**
 * The Studio extension for the ue-mcp daemon.
 *
 * On activation it trusts the UI signing keys built into this package,
 * installs the UI bundle it ships with when that is newer than what the daemon
 * serves, and registers Studio's routes under /v1/ext/studio/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import type { DaemonExtension, DaemonExtensionApi } from "ue-mcp/daemon";
import type { StudioAbout, StudioConfigFile } from "@ue-mcp-studio/shared";
import { registerChat } from "./chat-routes.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

const agentVersion = readJson<{ version: string }>(path.join(packageDir, "package.json"))?.version ?? "0.0.0";

/** Public keys written at build time from the repo's keys/ directory. */
function trustedKeys(): string[] {
  return readJson<string[]>(path.join(packageDir, "dist", "keys.json")) ?? [];
}

function newer(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { numeric: true }) > 0;
}

/** Install the UI bundle shipped beside this package when it is newer than the one being served. */
function installShippedUi(api: DaemonExtensionApi): void {
  const shipped = path.join(packageDir, "ui");
  const manifest = readJson<{ version: string }>(path.join(shipped, "manifest.json"));
  if (!manifest) return;
  const active = api.ui.active();
  if (active && !newer(manifest.version, active.version)) return;
  try {
    const installed = api.ui.install(shipped);
    api.log.info(`installed UI ${installed.version}`);
  } catch (e) {
    api.log.warn("the shipped UI bundle did not verify; it is not served", e);
  }
}

function configPath(api: DaemonExtensionApi): string {
  return path.join(api.projectDir, "ue-mcp.yml");
}

function readConfig(api: DaemonExtensionApi): StudioConfigFile {
  const file = configPath(api);
  const exists = fs.existsSync(file);
  return { path: file, exists, text: exists ? fs.readFileSync(file, "utf-8") : "" };
}

const extension: DaemonExtension = {
  activate(api) {
    for (const pem of trustedKeys()) {
      try {
        api.ui.trustKey(pem);
      } catch (e) {
        api.log.warn("a bundled UI key is not a valid Ed25519 public key", e);
      }
    }
    installShippedUi(api);

    api.route("GET", "/about", () => {
      const about: StudioAbout = {
        agentVersion,
        daemonVersion: api.version,
        uiVersion: api.ui.active()?.version ?? null,
        projectDir: api.projectDir,
      };
      return { body: about };
    });

    api.route("GET", "/config", () => ({ body: readConfig(api) }));

    // Refuses text that is not valid YAML, so a typo in the editor never lands on disk.
    api.route("PUT", "/config", (req) => {
      const text = (req.body as { text?: unknown } | undefined)?.text;
      if (typeof text !== "string") return { status: 400, body: { error: "body must be { text: string }" } };
      const doc = parseDocument(text);
      if (doc.errors.length > 0) {
        return { status: 400, body: { error: "not valid YAML", details: doc.errors.map((e) => e.message) } };
      }
      fs.writeFileSync(configPath(api), text);
      api.events.publish("config.saved", { path: configPath(api) });
      return { body: readConfig(api) };
    });

    const runner = registerChat(api, agentVersion);
    return { dispose: () => runner.dispose() };
  },
};

export default extension;
