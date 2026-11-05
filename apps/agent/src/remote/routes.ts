/**
 * Remote control, built into Studio: off until turned on in Settings; then the
 * connector keeps this project reachable from paired browsers through the
 * relay, and keeps the daemon from idling out while it is online.
 *
 * Works only while the signed-in account has a paid plan by the gateway
 * (./plan.ts), rechecked every few minutes so a new plan starts it and a
 * lapsed one stops it without a daemon restart. The account is the one chat
 * uses (../account-source.ts); a sign-in or sign-out there asks again at once. Otherwise every /remote/*
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
import { NOTIFY_EVENT, noticeOf, type RemoteApproval, type RemoteAvailability, type RemoteBrowser, type RemoteLockSettings, type RemotePairing, type RemoteStatus } from "@ue-mcp-studio/shared";
import type { ExtensionHandler } from "ue-mcp/daemon";
import { SettingsStore } from "../settings.js";
import { AccountSource } from "../account-source.js";
import { Connector, NOT_SIGNED_IN, NO_PLAN, type ConnectorState } from "./connector.js";
import { PLAN_CHECK_TTL_MS, RemotePlanCheck, type PlanCheck } from "./plan.js";
import { ComputerKeys } from "./keys.js";
import { RemoteService } from "./service.js";
import { PIN_PATTERN, PinLock } from "./pin-lock.js";

export const DEFAULT_RELAY = "https://remote.ue-mcp.com";

interface RemoteConfig {
  enabled: boolean;
  relay?: string;
}

export interface RemoteOptions {
  /** The ue-mcp account: a panel sign-in, else `ue-mcp login`. Default: read from this project's settings. */
  account?: AccountSource;
  /** Whether the account has a paid plan. Default: the gateway, with the account's token. */
  plan?: PlanCheck;
  /** How often the plan is rechecked. */
  planRecheckMs?: number;
  /** The per-computer key and paired-browser folder. Default <ue-mcp user dir>/remote. */
  computerDir?: string;
  /** This project's daemon, for the requests a browser sends. Default: its discovery file. */
  daemon?: () => { port: number; token: string } | null;
  env?: NodeJS.ProcessEnv;
  refusedRetryMs?: number;
  /** Whether this process is the project's daemon. Default: no live discovery record names another process. */
  owns?: () => boolean;
  /** Silence on a browser's event stream before a keepalive comment goes out. */
  keepaliveMs?: number;
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
  const account = o.account ?? new AccountSource(new SettingsStore(api.dataDir), () => api.registryAccount());
  const plan =
    o.plan ??
    new RemotePlanCheck({
      token: () => account.token(),
      gatewayUrl: () => new SettingsStore(api.dataDir).gatewayUrl(),
    });
  const dir = path.join(api.dataDir, "remote");
  const configFile = path.join(dir, "remote.json");
  const config = (): RemoteConfig => ({ enabled: false, ...readJson<RemoteConfig>(configFile) });
  const relayUrl = (): string => config().relay ?? env.UE_MCP_REMOTE_RELAY ?? DEFAULT_RELAY;
  // dataDir is <user dir>/data/<project key>/studio; the computer's identity sits beside "data".
  const computerDir = o.computerDir ?? path.resolve(api.dataDir, "..", "..", "..", "remote");
  const keys = new ComputerKeys(computerDir);
  // One PIN for every project on this computer, beside the paired browsers it guards.
  const lock = new PinLock({ file: path.join(computerDir, "remote-lock.json") });
  const settings = new SettingsStore(api.dataDir);
  const device = deviceId(dir, path.resolve(api.dataDir, "..", "remote"));
  const project = projectName(api.projectDir);
  const service = new RemoteService({
    keys,
    deviceId: device,
    pendingFile: path.join(dir, "pairing-secrets.json"),
    keepaliveMs: o.keepaliveMs,
    onApproval: (a) => api.events.publish("remote.approval", { ...a, project }),
    onPaired: (p) => api.events.publish("remote.paired", { id: p.id, label: p.label, addedAt: p.addedAt }),
    lock,
    risky: () => {
      const a = settings.approvals();
      return a.shell !== "ask" || a.files !== "ask";
    },
    onLockout: (p) => api.events.publish("remote.lockout", { id: p.id, label: p.label }),
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
      deviceName: `${project} on ${os.hostname()}`,
      computerPublic: (await keys.identity()).publicKey,
      token: () => account.token(),
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
      onDiagnostic: (d) => api.events.publish("remote.diagnostic", { ...d }),
      refusedRetryMs: o.refusedRetryMs,
      // A daemon whose discovery record a newer one replaced must not keep the project's relay connection.
      owns:
        o.owns ??
        (() => {
          const d = readLiveDiscovery(api.projectDir);
          return !d || d.pid === process.pid;
        }),
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

  // A sign-in, sign-out or switch of account: ask the gateway again, and reconnect as the new account.
  const unwatch = account.onChange(() => {
    plan.invalidate();
    const before = available;
    void recheck(true).then(async () => {
      if (before && available && !disposed) await apply();
    });
  });

  // Settings asks on open with ?refresh, so a plan bought a minute ago shows without waiting out the cache.
  api.route("GET", "/remote/available", async (req) => {
    const ok = await recheck(req.query?.refresh !== undefined);
    const body: RemoteAvailability = { available: ok, signedIn: account.current() !== null };
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
    const token = await account.token();
    if (!token) return { status: 401, body: { error: NOT_SIGNED_IN, code: "signed-out" } };
    if (state.state === "error" && state.code === "no-plan") return { status: 403, body: { error: NO_PLAN, code: "no-plan" } };
    if (state.state !== "online") return { status: 409, body: { error: "Turn remote control on and wait for it to connect first." } };
    const res = await fetch(new URL("/api/pair", relayUrl()), { method: "POST", headers: { authorization: `Bearer ${token}`, "x-ue-mcp-device": device } }).catch(() => null);
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
  // The owner allows or denies a browser that scanned a code. Under /remote, so a paired browser can never reach them (remotePath).
  route("GET", "/remote/approvals", () => {
    const approvals: RemoteApproval[] = service.pendingApprovals().map((a) => ({ ...a, project }));
    return { body: { approvals } };
  });
  route("POST", "/remote/approvals/:id", async (req) => {
    const allow = (req.body as { allow?: unknown } | undefined)?.allow;
    if (typeof allow !== "boolean") return { status: 400, body: { error: "allow must be true or false" } };
    const r = await service.decide(req.params.id, allow);
    if (!r.ok) return { status: 409, body: { error: r.error } };
    api.events.publish("remote.approval", { id: req.params.id, decided: allow ? "allowed" : "denied" });
    return { body: { ok: true, ...(r.phone ? { browser: { id: r.phone.id, label: r.phone.label, addedAt: r.phone.addedAt } } : {}) } };
  });
  route("GET", "/remote/browsers", () => {
    const browsers: RemoteBrowser[] = keys.phones().map(({ id, label, addedAt }) => ({ id, label, addedAt }));
    return { body: { browsers } };
  });
  route("DELETE", "/remote/browsers/:id", (req) => {
    if (!keys.removePhone(req.params.id)) return { status: 404, body: { error: "No such device." } };
    service.cutOff(req.params.id);
    lock.forget(req.params.id);
    return { status: 204 };
  });
  // The PIN lock, set here on the computer. Under /remote, so a paired browser can never set, change or remove it (remotePath).
  const lockChanged = (): { body: RemoteLockSettings } => {
    const body = lock.settings();
    api.events.publish("remote.lock", { ...body });
    return { body };
  };
  route("GET", "/remote/lock", () => ({ body: lock.settings() }));
  route("PUT", "/remote/lock/pin", async (req) => {
    const pin = (req.body as { pin?: unknown } | undefined)?.pin;
    if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) return { status: 400, body: { error: "A PIN is 4 to 8 digits." } };
    await lock.setPin(pin);
    return lockChanged();
  });
  route("DELETE", "/remote/lock/pin", () => {
    lock.removePin();
    return lockChanged();
  });
  route("PUT", "/remote/lock", (req) => {
    const b = (req.body ?? {}) as { whole?: unknown; sensitive?: unknown; idleMinutes?: unknown };
    for (const k of ["whole", "sensitive"] as const) if (b[k] !== undefined && typeof b[k] !== "boolean") return { status: 400, body: { error: `${k} must be true or false` } };
    if (b.idleMinutes !== undefined && typeof b.idleMinutes !== "number") return { status: 400, body: { error: "idleMinutes must be a number" } };
    try {
      lock.configure({ whole: b.whole as boolean | undefined, sensitive: b.sensitive as boolean | undefined, idleMinutes: b.idleMinutes as number | undefined });
    } catch (e) {
      return { status: 409, body: { error: e instanceof Error ? e.message : String(e) } };
    }
    return lockChanged();
  });
  // The desktop's own Studio is never locked; a paired browser's GET of this path is answered by the connector before it gets here.
  api.route("GET", "/lock", () => ({ body: { whole: false, sensitive: false, locked: false, sensitiveOpen: true, idleMinutes: 0 } }));

  void recheck(true);
  const timer = setInterval(() => void recheck(true), o.planRecheckMs ?? PLAN_CHECK_TTL_MS);
  timer.unref?.();
  // Long synchronous work in this process (saving a large session, building a big answer) holds every remote call
  // and the relay socket. Report a stall for Diagnostics, so a paired browser that waited has a cause on record.
  const stopLag = watchLag((ms) => {
    api.log.info(`remote control: this process was busy for ${(ms / 1000).toFixed(1)}s; remote calls waited`);
    api.events.publish("remote.diagnostic", { kind: "lag", ms });
  });
  // A notice goes on to the relay as its kind only, for the account's devices that are away.
  const unwatchNotices = api.events.subscribe((e) => {
    if (e.type !== NOTIFY_EVENT) return;
    const n = noticeOf(e.data);
    if (n) connector?.notify(n.kind, !!n.active?.includes("desktop"));
  });
  return {
    dispose: () => {
      disposed = true;
      unwatch();
      unwatchNotices();
      generation++;
      clearInterval(timer);
      stopLag();
      connector?.stop();
    },
  };
}

/** How often the lag watch ticks, and the stall it reports. */
export const LAG_TICK_MS = 250;
export const LAG_REPORT_MS = 1000;

/** Call `report` with the length of each stall of the event loop of at least LAG_REPORT_MS, at most once every 10 seconds. */
export function watchLag(report: (ms: number) => void, now: () => number = Date.now): () => void {
  let expected = now() + LAG_TICK_MS;
  let lastReport = Number.NEGATIVE_INFINITY;
  const t = setInterval(() => {
    const at = now();
    const lag = at - expected;
    expected = at + LAG_TICK_MS;
    if (lag >= LAG_REPORT_MS && at - lastReport >= 10_000) {
      lastReport = at;
      report(lag);
    }
  }, LAG_TICK_MS);
  t.unref?.();
  return () => clearInterval(t);
}
