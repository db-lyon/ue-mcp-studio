/**
 * Remote control, built into Studio: off until turned on in Settings; then the
 * connector keeps this project reachable from paired browsers through the
 * relay, and keeps the daemon from idling out while it is online.
 *
 * Works only while the signed-in account has a paid plan by the gateway
 * (./plan.ts), rechecked every few minutes so a new plan starts it and a
 * lapsed one stops it without a daemon restart. Otherwise every /remote/*
 * route answers 404 and the connector stays down. STUDIO_PLAN_AVAILABLE only
 * decides whether the UI tells a free account about it.
 *
 * Per project, in <studio data dir>/remote/: remote.json (on or off, optional
 * relay override) and device.json (this project's stable id). Per computer,
 * in <ue-mcp user dir>/remote/: the key pair and paired browsers (./keys.ts).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import qrcode from "qrcode-generator";
import { readLiveDiscovery, type DaemonExtensionApi } from "ue-mcp/daemon";
import { pairingFragment } from "@ue-mcp-studio/remote";
import { type RemoteAvailability, type RemoteBrowser, type RemotePairing, type RemoteStatus } from "@ue-mcp-studio/shared";
import type { ExtensionHandler } from "ue-mcp/daemon";
import { SettingsStore } from "../settings.js";
import { Connector, NO_PLAN, type ConnectorState } from "./connector.js";
import { PLAN_CHECK_TTL_MS, RemotePlanCheck, type PlanCheck } from "./plan.js";
import { ComputerKeys } from "./keys.js";
import { RemoteService } from "./service.js";

export const DEFAULT_RELAY = "https://remote.ue-mcp.com";

interface RemoteConfig {
  enabled: boolean;
  relay?: string;
}

export interface RemoteOptions {
  /** Whether the account has a paid plan. Default: the gateway, with the `ue-mcp login` token. */
  plan?: PlanCheck;
  /** How often the plan is rechecked. */
  planRecheckMs?: number;
  /** The per-computer key and paired-browser folder. Default <ue-mcp user dir>/remote. */
  computerDir?: string;
  /** This project's daemon, for the requests a browser sends. Default: its discovery file. */
  daemon?: () => { port: number; token: string } | null;
  env?: NodeJS.ProcessEnv;
  refusedRetryMs?: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const UUID = /^[0-9a-f-]{36}$/;

/** This project's id at the relay, kept from the standalone remote extension when that ran here first. */
export function deviceId(dir: string, legacyDir?: string): string {
  const file = path.join(dir, "device.json");
  const known = readJson<{ id?: string }>(file)?.id;
  if (known && UUID.test(known)) return known;
  const legacy = legacyDir ? readJson<{ id?: string }>(path.join(legacyDir, "device.json"))?.id : undefined;
  const id = legacy && UUID.test(legacy) ? legacy : crypto.randomUUID();
  writeJson(file, { id });
  return id;
}

function projectName(projectDir: string): string {
  const uproject = fs.existsSync(projectDir) ? fs.readdirSync(projectDir).find((f) => f.endsWith(".uproject")) : undefined;
  return uproject ? uproject.replace(/\.uproject$/, "") : path.basename(projectDir);
}

/** Registers /remote/* and starts the connector when it is on and remote control is offered. */
export function registerRemote(api: DaemonExtensionApi, o: RemoteOptions = {}): { dispose(): void } {
  const env = o.env ?? process.env;
  const plan =
    o.plan ??
    new RemotePlanCheck({
      token: async () => (await api.registryAccount().catch(() => null))?.token ?? null,
      gatewayUrl: () => new SettingsStore(api.dataDir).gatewayUrl(),
    });
  const dir = path.join(api.dataDir, "remote");
  const configFile = path.join(dir, "remote.json");
  const config = (): RemoteConfig => ({ enabled: false, ...readJson<RemoteConfig>(configFile) });
  const relayUrl = (): string => config().relay ?? env.UE_MCP_REMOTE_RELAY ?? DEFAULT_RELAY;
  // dataDir is <user dir>/data/<project key>/studio; the computer's identity sits beside "data".
  const keys = new ComputerKeys(o.computerDir ?? path.resolve(api.dataDir, "..", "..", "..", "remote"));
  const device = deviceId(dir, path.resolve(api.dataDir, "..", "remote"));
  const service = new RemoteService({
    keys,
    deviceId: device,
    daemon:
      o.daemon ??
      (() => {
        const d = readLiveDiscovery(api.projectDir);
        return d ? { port: d.port, token: d.token } : null;
      }),
  });

  let connector: Connector | null = null;
  let state: ConnectorState = { state: "off" };
  const status = (): RemoteStatus => ({ enabled: config().enabled, relay: relayUrl(), ...state });
  const build = async (): Promise<Connector> =>
    new Connector({
      relayUrl: relayUrl(),
      deviceId: device,
      deviceName: `${projectName(api.projectDir)} on ${os.hostname()}`,
      computerPublic: (await keys.identity()).publicKey,
      token: async () => (await api.registryAccount())?.token ?? null,
      handle: (kind, body, sink, signal) => (kind === "enroll" ? service.enroll(body, sink) : service.sealed(body, sink, signal)),
      onState: (s) => {
        state = s;
        // The relay says the plan does not cover it: ask the gateway again rather than wait out the cache.
        if (s.state === "error" && s.code === "no-plan") {
          plan.invalidate();
          void recheck(true);
        }
        api.events.publish("remote.status", { ...status() });
      },
      log: (m) => api.log.info(m),
      refusedRetryMs: o.refusedRetryMs,
    });
  let generation = 0;
  let disposed = false;
  let available = false;
  const apply = async (): Promise<void> => {
    const mine = ++generation;
    connector?.stop();
    connector = null;
    state = { state: "off" };
    if (!config().enabled || !available || disposed) return;
    const next = await build();
    if (mine !== generation) return;
    connector = next;
    connector.start();
  };

  /** Whether this account may use remote control now; a change starts or stops the connector and tells the UI. */
  const recheck = async (force = false): Promise<boolean> => {
    if (disposed) return available;
    const next = await plan.available(force);
    if (next !== available && !disposed) {
      available = next;
      api.events.publish("remote.available", { available });
      await apply();
    }
    return available;
  };

  // While a browser can reach this project, the daemon must not idle out under it.
  api.setBusy(() => state.state === "online");

  const NOT_FOUND = { status: 404, body: { error: "Not found." } };
  const route = (method: "GET" | "PUT" | "POST" | "DELETE", p: string, h: ExtensionHandler): void =>
    api.route(method, p, async (req) => ((await recheck()) ? h(req) : NOT_FOUND));

  // Settings asks on open with ?refresh, so a plan bought a minute ago shows without waiting out the cache.
  api.route("GET", "/remote/available", async (req) => {
    const body: RemoteAvailability = { available: await recheck(req.query?.refresh !== undefined) };
    return { body };
  });
  route("GET", "/remote/status", () => ({ body: status() }));
  route("PUT", "/remote/config", async (req) => {
    const b = (req.body ?? {}) as { enabled?: unknown };
    if (typeof b.enabled !== "boolean") return { status: 400, body: { error: "enabled must be true or false" } };
    writeJson(configFile, { ...config(), enabled: b.enabled });
    await apply();
    return { body: status() };
  });
  route("POST", "/remote/pair", async () => {
    const account = await api.registryAccount().catch(() => null);
    if (!account) return { status: 401, body: { error: "Not signed in. Run `npx ue-mcp login` on this computer.", code: "signed-out" } };
    if (state.state === "error" && state.code === "no-plan") return { status: 403, body: { error: NO_PLAN, code: "no-plan" } };
    if (state.state !== "online") return { status: 409, body: { error: "Turn remote control on and wait for it to connect first." } };
    const res = await fetch(new URL("/api/pair", relayUrl()), { method: "POST", headers: { authorization: `Bearer ${account.token}`, "x-ue-mcp-device": device } }).catch(() => null);
    if (!res) return { status: 502, body: { error: "Could not reach the relay." } };
    const body = (await res.json().catch(() => ({}))) as { url?: string; code?: string; expiresAt?: string; error?: string };
    if (res.status === 403) {
      plan.invalidate();
      return { status: 403, body: { error: NO_PLAN, code: "no-plan" } };
    }
    if (!res.ok || !body.url || !body.code) return { status: res.ok ? 502 : res.status, body: { error: body.error ?? `The relay answered HTTP ${res.status}.` } };
    // The fragment never reaches the relay: it carries this computer's key and the secret that proves a browser scanned it.
    const url = `${body.url.split("#")[0]}#${pairingFragment(body.code, (await keys.identity()).publicKey, service.newPairingSecret())}`;
    const qr = qrcode(0, "L");
    qr.addData(url);
    qr.make();
    const pairing: RemotePairing = { url, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}), svg: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) };
    return { body: pairing };
  });
  route("GET", "/remote/browsers", () => {
    const browsers: RemoteBrowser[] = keys.phones().map(({ id, label, addedAt }) => ({ id, label, addedAt }));
    return { body: { browsers } };
  });
  route("DELETE", "/remote/browsers/:id", (req) => {
    if (!keys.removePhone(req.params.id)) return { status: 404, body: { error: "No such browser." } };
    service.cutOff(req.params.id);
    return { status: 204 };
  });

  void recheck(true);
  const timer = setInterval(() => void recheck(true), o.planRecheckMs ?? PLAN_CHECK_TTL_MS);
  timer.unref?.();
  return {
    dispose: () => {
      disposed = true;
      generation++;
      clearInterval(timer);
      connector?.stop();
    },
  };
}
