/**
 * The app's side of remote control, the native counterpart of the relay's
 * pairing page and service worker: pair with a computer through its QR code,
 * list the account's projects, and reach a project's daemon through sealed
 * requests whose responses stream back frame by frame.
 *
 * The relay session is the cookie redeem sets, kept by the platform's cookie
 * store (shared by fetch and the native networking stack). The relay refuses
 * requests whose Origin is not its own, so every call names the relay's origin,
 * as its own pages do.
 */
import { ACCEPT_GZIP, b64u, exportPrivateJwk, exportPublic, generateKeyPair, importPrivateJwk, keyId, pairingCode, pairingMac, parsePairingFragment, ResponseOpener, sealRequest, sharedSecret, type ResponseHead } from "@ue-mcp-studio/remote";
import type { Reply, Transport } from "@ue-mcp-studio/client-core";
import { Gunzip } from "fflate";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const RELAY = "https://remote.ue-mcp.com";
/**
 * Where relay calls go. Always RELAY in the app; the e2e page (apps/mobile/visual-qa/app.html)
 * sets __studioRelayBase to its own proxy, since a browser cannot call the relay cross-origin.
 */
const harness = globalThis as { __studioRelayBase?: string; __studioDeviceLabel?: string };
const BASE = harness.__studioRelayBase ?? RELAY;
const LABEL = harness.__studioDeviceLabel ?? `${Platform.OS === "ios" ? "iPhone" : "Android"} (Studio app)`;
const POLL_MS = 2000;
/** The relay answers a call's head within 30 seconds (504 past that); later than this, the connection is dead. */
export const E2E_HEAD_TIMEOUT_MS = 40_000;
/** A streamed body through the relay carries keepalives every 20 seconds; this long with no bytes, it is dead. */
export const E2E_IDLE_MS = 50_000;

export interface Device {
  id: string;
  name: string;
  online: boolean;
  computerKey: string;
  lastSeen: string;
}

export interface Viewer {
  id: string;
  label: string;
  createdAt: string;
  current: boolean;
}

interface PhoneKey {
  privateKey: CryptoKey;
  publicKey: string;
  id: string;
}

type Trusted = Record<string, { pairedAt: string }>;

async function readStored<T>(k: string): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(k);
  return raw ? (JSON.parse(raw) as T) : null;
}
const writeStored = (k: string, v: unknown) => SecureStore.setItemAsync(k, JSON.stringify(v));

let phone: Promise<PhoneKey> | null = null;

/** This phone's key pair, made on first use; the private half lives only in the platform's secure store. */
export function phoneKey(): Promise<PhoneKey> {
  phone ??= (async () => {
    const known = await readStored<{ jwk: JsonWebKey; publicKey: string }>("phone");
    if (known) return { privateKey: await importPrivateJwk(known.jwk), publicKey: known.publicKey, id: await keyId(known.publicKey) };
    const pair = await generateKeyPair(true);
    const publicKey = await exportPublic(pair.publicKey);
    const jwk = await exportPrivateJwk(pair.privateKey);
    await writeStored("phone", { jwk, publicKey });
    return { privateKey: await importPrivateJwk(jwk), publicKey, id: await keyId(publicKey) };
  })().catch((e) => {
    phone = null;
    throw e;
  });
  return phone;
}

export const trusted = async (): Promise<Trusted> => (await readStored<Trusted>("trusted")) ?? {};

async function trust(computerPublic: string): Promise<void> {
  await writeStored("trusted", { ...(await trusted()), [computerPublic]: { pairedAt: new Date().toISOString() } });
}

/** Stop trusting one computer: its sealed requests can no longer be made from this phone. */
export async function forgetComputer(computerPublic: string): Promise<void> {
  const t = await trusted();
  delete t[computerPublic];
  await writeStored("trusted", t);
  secrets.delete(computerPublic);
  const sel = await selected();
  if (sel?.computerKey === computerPublic) await SecureStore.deleteItemAsync("selected");
}

/** Forget every computer and the open project. The key pair stays, so pairing again is the same phone. */
export async function forget(): Promise<void> {
  await SecureStore.deleteItemAsync("trusted");
  await SecureStore.deleteItemAsync("selected");
  secrets.clear();
}

export const selected = () => readStored<Device>("selected");
export const select = (d: Device) => writeStored("selected", d);

const relayHeaders = { origin: RELAY, "content-type": "application/json", accept: "application/json" };

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(BASE + path, { method: "POST", headers: relayHeaders, credentials: "include", body: JSON.stringify(body) });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

/** The pairing fragment from whatever the QR code held: the relay's /pair link, or the bare fragment. */
export function fragmentOf(scanned: string): string {
  const s = scanned.trim();
  const hash = s.indexOf("#");
  return hash >= 0 ? s.slice(hash + 1) : s;
}

/**
 * Whether a link is a pairing link: the relay's /pair link pasted into the app,
 * or the app's own uemcpstudio://pair# link. The app never claims the relay's
 * https links, so a code scanned with the camera or opened in a browser stays
 * in the browser.
 */
export function isPairLink(url: string): boolean {
  return url.startsWith(`${RELAY}/pair#`) || url.startsWith("uemcpstudio://pair#");
}

export type PairStep = { kind: "status"; text: string } | { kind: "code"; code: string };

/** Pairs with the computer whose QR code was scanned. Resolves once the owner allowed this phone; throws with the reason otherwise. */
export async function pair(scanned: string, onStep: (s: PairStep) => void): Promise<void> {
  const parts = parsePairingFragment(fragmentOf(scanned));
  if (!parts) throw new Error("That is not a UE-MCP Studio pairing code. Make a new one on your computer.");
  onStep({ kind: "status", text: "Contacting the relay" });
  const redeemed = await post("/api/pair/redeem", { code: parts.code, label: LABEL });
  const deviceId = redeemed.body.deviceId;
  if (redeemed.status !== 200 || typeof deviceId !== "string") throw new Error(String(redeemed.body.error ?? `Pairing failed (${redeemed.status}). Make a new code and try again.`));

  onStep({ kind: "status", text: "Pairing with your computer" });
  const me = await phoneKey();
  let a = await post("/api/pair/enroll", { deviceId, phonePublic: me.publicKey, mac: await pairingMac(parts.secret, me.publicKey, parts.computerPublic), label: LABEL });
  if (a.status === 202 && typeof a.body.approval === "string") {
    onStep({ kind: "code", code: await pairingCode(parts.secret, me.publicKey) });
    const approval = a.body.approval;
    while (a.status === 202) {
      await new Promise((done) => setTimeout(done, POLL_MS));
      a = await post("/api/pair/enroll", { deviceId, poll: approval });
    }
  }
  if (a.status !== 200) throw new Error(String(a.body.error ?? "Your computer did not accept this phone. Make a new code and try again."));
  // The relay could answer for the computer; what matters is that the key we trust is the one the code carried.
  if (a.body.computerPublic !== parts.computerPublic || a.body.phoneId !== me.id) throw new Error("The answer did not match the pairing code. Make a new code and try again.");
  await trust(parts.computerPublic);
}

export class NotPairedError extends Error {}

/** The account's projects and paired clients, as the relay knows them. */
export async function account(): Promise<{ devices: Device[]; viewers: Viewer[] }> {
  const res = await fetch(`${BASE}/api/devices`, { headers: relayHeaders, credentials: "include" });
  if (res.status === 401) throw new NotPairedError("This phone is not paired.");
  if (!res.ok) throw new Error(`The relay answered ${res.status}.`);
  const body = (await res.json()) as { devices: Device[]; viewers?: Viewer[] };
  return { devices: body.devices, viewers: body.viewers ?? [] };
}

/** Remove a paired client from the account; removing this phone also forgets every computer here. */
export async function removeViewer(v: Viewer): Promise<void> {
  const res = await fetch(`${BASE}/viewers/${encodeURIComponent(v.id)}/revoke`, { method: "POST", headers: { origin: RELAY }, credentials: "include" });
  if (res.status >= 400) throw new Error(`The relay answered ${res.status}.`);
  if (v.current) await forget();
}

const secrets = new Map<string, Promise<CryptoKey>>();

function secretWith(computerPublic: string): Promise<CryptoKey> {
  let s = secrets.get(computerPublic);
  if (!s) {
    s = phoneKey().then((me) => sharedSecret(me.privateKey, computerPublic));
    s.catch(() => secrets.delete(computerPublic));
    secrets.set(computerPublic, s);
  }
  return s;
}

/** Fires once `ms` after the last touch, until stopped. */
class Watchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly ms: number,
    private readonly fire: () => void,
  ) {}
  touch(): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fire();
    }, this.ms);
  }
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The relay's own refusal (offline, not paired, plan), before any sealed answer. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A Transport to one project's daemon: each request sealed for its computer,
 * each response opened frame by frame as it streams, gzip opened here. A head
 * later than its deadline or a body silent past E2E_IDLE_MS aborts the request.
 */
export function transportFor(device: Device): Transport {
  return async (method, path, options = {}): Promise<Reply> => {
    if (!(device.computerKey in (await trusted()))) throw new NotPairedError("This phone is not paired with that computer.");
    const me = await phoneKey();
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = b64u(new TextEncoder().encode(JSON.stringify(options.json)) as Uint8Array<ArrayBuffer>);
    }
    const { sealed, responseKey } = await sealRequest(await secretWith(device.computerKey), me.id, {
      id: crypto.randomUUID(),
      ts: Date.now(),
      device: device.id,
      method,
      path,
      headers,
      accept: [ACCEPT_GZIP],
      ...(body !== undefined ? { body } : {}),
    });

    const abort = new AbortController();
    const outer = options.signal;
    const onOuter = () => abort.abort();
    if (outer?.aborted) abort.abort();
    outer?.addEventListener("abort", onOuter, { once: true });
    const headLate = new Watchdog(Math.min(options.headTimeoutMs ?? E2E_HEAD_TIMEOUT_MS, E2E_HEAD_TIMEOUT_MS), () => abort.abort());
    headLate.touch();

    const opener = new ResponseOpener(responseKey);
    const pending: Uint8Array[] = [];
    let head: ResponseHead | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const res = await fetch(`${BASE}/e2e/${encodeURIComponent(device.id)}`, { method: "POST", headers: relayHeaders, credentials: "include", body: JSON.stringify(sealed), signal: abort.signal });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 401) throw new NotPairedError(err.error ?? "Not paired.");
        throw new RelayError(res.status, err.error ?? `The relay answered ${res.status}.`);
      }
      reader = res.body.getReader();
      while (!head) {
        const { done, value } = await reader.read();
        if (done) throw new Error("The response ended before its head.");
        for (const f of await opener.push(value)) {
          if (f.kind === "head") head = f.head;
          else if (f.kind === "data") pending.push(f.data);
        }
      }
    } catch (e) {
      outer?.removeEventListener("abort", onOuter);
      throw e;
    } finally {
      headLate.stop();
    }

    const { "content-encoding": encoding, ...plainHeaders } = head.headers;
    const gzip = encoding === "gzip";
    async function* frames(): AsyncGenerator<Uint8Array> {
      const quiet = new Watchdog(E2E_IDLE_MS, () => abort.abort());
      try {
        for (const d of pending) yield d;
        while (!opener.finished) {
          quiet.touch();
          const { done, value } = await reader.read();
          if (done) throw new Error("The response was cut off before it finished.");
          for (const f of await opener.push(value)) if (f.kind === "data") yield f.data;
        }
      } finally {
        quiet.stop();
        outer?.removeEventListener("abort", onOuter);
        if (!opener.finished) {
          abort.abort();
          reader.cancel().catch(() => undefined);
        }
      }
    }
    async function* gunzipped(): AsyncGenerator<Uint8Array> {
      const out: Uint8Array[] = [];
      const g = new Gunzip((chunk) => out.push(chunk));
      for await (const d of frames()) {
        g.push(d);
        while (out.length) yield out.shift()!;
      }
      g.push(new Uint8Array(0), true);
      while (out.length) yield out.shift()!;
    }
    const noBody = [204, 205, 304].includes(head.status) || method === "HEAD";
    if (noBody) {
      abort.abort();
      outer?.removeEventListener("abort", onOuter);
    }
    return { status: head.status, headers: gzip ? plainHeaders : head.headers, body: noBody ? null : gzip ? gunzipped() : frames() };
  };
}
