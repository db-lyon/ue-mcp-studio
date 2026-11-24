/**
 * The Studio extension for the ue-mcp daemon.
 *
 * On activation it trusts the UI signing keys built into this package,
 * installs the UI bundle it ships with when that is newer than what the daemon
 * serves, and registers Studio's routes under /v1/ext/studio/. On a ue-mcp
 * below its floor it registers only the refusal route (floor.ts). Remote
 * control works while the signed-in account has a paid plan (remote/routes.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import type { DaemonExtension, DaemonExtensionApi } from "ue-mcp/daemon";
import type { StudioConfigFile } from "@ue-mcp-studio/shared";
import { shareBusy } from "./busy-sources.js";
import { registerRemote } from "./remote/routes.js";
import { studioAbout } from "./about.js";
import { registerChat } from "./chat-routes.js";
import { AccountSource } from "./account-source.js";
import { registerBilling } from "./billing-routes.js";
import { SettingsStore } from "./settings.js";
import { isNewer } from "./updates.js";
import { floorRefusal, registerRefusal } from "./floor.js";
import { installCrashGuard } from "./crash-guard.js";
import { ViewportAccessCheck, actionBridge, readViewportConfig, registerViewport } from "./viewport/routes.js";
import { TurnCredentials } from "./viewport/turn.js";
import { PieWatch } from "./viewport/pie-watch.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

const agentPackage = readJson<{ version: string; ueMcpExtension?: { ueMcp?: string } }>(path.join(packageDir, "package.json"));
const agentVersion = agentPackage?.version ?? "0.0.0";

/** Public keys written at build time from the repo's keys/ directory. */
function trustedKeys(): string[] {
  return readJson<string[]>(path.join(packageDir, "dist", "keys.json")) ?? [];
}

/** Install the UI bundle shipped beside this package when it is newer than the one being served. */
function installShippedUi(api: DaemonExtensionApi): void {
  const shipped = path.join(packageDir, "ui");
  const manifest = readJson<{ version: string }>(path.join(shipped, "manifest.json"));
  if (!manifest) return;
  const active = api.ui.active();
  if (active && !isNewer(manifest.version, active.version)) return;
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

    const refusal = floorRefusal(agentPackage?.ueMcpExtension?.ueMcp, api.version);
    if (refusal) {
      registerRefusal(api, refusal);
      return { dispose: () => {} };
    }

    // An error Studio lets escape is logged, not the end of the daemon, its other sessions and the editor bridge.
    const unguard = installCrashGuard({ dir: packageDir, log: api.log });

    api.route("GET", "/about", () => ({ body: studioAbout(agentVersion, api) }));

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

    const host = shareBusy(api);
    // One account for chat and remote control, so a panel sign-in or sign-out reaches both.
    const account = new AccountSource(new SettingsStore(host.dataDir), () => host.registryAccount());
    // Whether PIE runs, for the chat's indicator and card; the chat's calls are watched and kept off the Viewport tab's stream.
    const pie = new PieWatch({
      callAction: (c, a, args) => host.callAction(c, a, args),
      connected: () => host.editors().some((e) => e.connected),
      changed: () => host.events.publish("viewport.changed", { pie: pie.get() }),
      pushed: () => (host.features ?? []).includes("events.pie"),
    });
    const unwatch = host.events.subscribe((e) => pie.observe(e));
    void pie.refresh();
    const chatHost = pie.wrap(host);
    const chat = registerChat(chatHost, agentVersion, packageDir, account, pie);
    const remote = registerRemote(host, { account });
    registerBilling(host, { account, gatewayUrl: () => new SettingsStore(host.dataDir).gatewayUrl() });
    // The live viewport: Pixel Streaming from the editor, signalled through Studio, for Pro accounts.
    const viewport = registerViewport(host, {
      access: new ViewportAccessCheck({ token: () => account.token(), gatewayUrl: () => new SettingsStore(host.dataDir).gatewayUrl() }),
      bridge: actionBridge(host),
      config: () => readViewportConfig(host.dataDir),
      turn: new TurnCredentials({ token: () => account.token(), gatewayUrl: () => new SettingsStore(host.dataDir).gatewayUrl(), log: (m) => api.log.info(m) }),
      log: (m) => api.log.info(m),
      pie,
      changed: () => host.events.publish("viewport.changed", { pie: pie.get() }),
    });
    return {
      dispose: () => {
        unwatch();
        viewport.dispose();
        remote.dispose();
        chat.dispose();
        unguard();
      },
    };
  },
};

export default extension;
