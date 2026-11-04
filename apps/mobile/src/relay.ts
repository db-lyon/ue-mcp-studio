/**
 * The app's side of remote control, the native counterpart of the relay's
 * pairing page and service worker: pair with a computer through its QR code,
 * list the account's projects, and send sealed requests to one of them.
 *
 * The relay session is the cookie redeem sets, kept by the platform's HTTP
 * cookie store. The relay refuses requests whose Origin is not its own, so
 * every call names the relay's origin, as its own pages do.
 */
import { exportPrivateJwk, exportPublic, generateKeyPair, importPrivateJwk, keyId, pairingCode, pairingMac, parsePairingFragment, ResponseOpener, sealRequest, sharedSecret, b64u, type ResponseHead } from "@ue-mcp-studio/remote";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const RELAY = "https://remote.ue-mcp.com";
const LABEL = `${Platform.OS === "ios" ? "iPhone" : "Android"} (Studio app)`;
const POLL_MS = 2000;

export interface Device {
  id: string;
  name: string;
  online: boolean;
  computerKey: string;
  lastSeen: string;
}

interface PhoneKey {
  privateKey: CryptoKey;
  publicKey: string;
  id: string;
}

type Trusted = Record<string, { pairedAt: string }>;

async function readJson<T>(k: string): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(k);
  return raw ? (JSON.parse(raw) as T) : null;
}
const writeJson = (k: string, v: unknown) => SecureStore.setItemAsync(k, JSON.stringify(v));

let phone: Promise<PhoneKey> | null = null;

/** This phone's key pair, made on first use; the private half lives only in the platform's secure store. */
export function phoneKey(): Promise<PhoneKey> {
  phone ??= (async () => {
    const known = await readJson<{ jwk: JsonWebKey; publicKey: string }>("phone");
    if (known) return { privateKey: await importPrivateJwk(known.jwk), publicKey: known.publicKey, id: await keyId(known.publicKey) };
    const pair = await generateKeyPair(true);
    const publicKey = await exportPublic(pair.publicKey);
    await writeJson("phone", { jwk: await exportPrivateJwk(pair.privateKey), publicKey });
    return { privateKey: await importPrivateJwk(await exportPrivateJwk(pair.privateKey)), publicKey, id: await keyId(publicKey) };
  })().catch((e) => {
    phone = null;
    throw e;
  });
  return phone;
}

export const trusted = async (): Promise<Trusted> => (await readJson<Trusted>("trusted")) ?? {};

async function trust(computerPublic: string): Promise<void> {
  await writeJson("trusted", { ...(await trusted()), [computerPublic]: { pairedAt: new Date().toISOString() } });
}

export async function forget(): Promise<void> {
  await SecureStore.deleteItemAsync("trusted");
  await SecureStore.deleteItemAsync("selected");
}

export const selected = () => readJson<Device>("selected");
export const select = (d: Device) => writeJson("selected", d);

const relayHeaders = { origin: RELAY, "content-type": "application/json", accept: "application/json" };

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(RELAY + path, { method: "POST", headers: relayHeaders, credentials: "include", body: JSON.stringify(body) });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

/** The pairing fragment from whatever the QR code held: the relay's /pair link, or the bare fragment. */
export function fragmentOf(scanned: string): string {
  const s = scanned.trim();
  const hash = s.indexOf("#");
  return hash >= 0 ? s.slice(hash + 1) : s;
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

/** The account's projects, as the relay knows them. */
export async function devices(): Promise<Device[]> {
  const res = await fetch(`${RELAY}/api/devices`, { headers: relayHeaders, credentials: "include" });
  if (res.status === 401) throw new NotPairedError("This phone is not paired.");
  if (!res.ok) throw new Error(`The relay answered ${res.status}.`);
  return ((await res.json()) as { devices: Device[] }).devices;
}

const secrets = new Map<string, Promise<CryptoKey>>();

function secretWith(computerPublic: string): Promise<CryptoKey> {
  let s = secrets.get(computerPublic);
  if (!s) {
    s = phoneKey().then((me) => sharedSecret(me.privateKey, computerPublic));
    secrets.set(computerPublic, s);
  }
  return s;
}

export interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** One request to a project's daemon, sealed for its computer and opened here. */
export async function call(device: Device, method: string, path: string, body?: unknown): Promise<Answer> {
  if (!(device.computerKey in (await trusted()))) throw new NotPairedError("This phone is not paired with that computer.");
  const me = await phoneKey();
  const headers: Record<string, string> = { accept: "application/json" };
  let sealedBody: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    sealedBody = b64u(new TextEncoder().encode(JSON.stringify(body)) as Uint8Array<ArrayBuffer>);
  }
  const { sealed, responseKey } = await sealRequest(await secretWith(device.computerKey), me.id, {
    id: crypto.randomUUID(),
    ts: Date.now(),
    device: device.id,
    method,
    path,
    headers,
    ...(sealedBody !== undefined ? { body: sealedBody } : {}),
  });
  const res = await fetch(`${RELAY}/e2e/${encodeURIComponent(device.id)}`, { method: "POST", headers: relayHeaders, credentials: "include", body: JSON.stringify(sealed) });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401) throw new NotPairedError(err.error ?? "Not paired.");
    throw new Error(err.error ?? `The relay answered ${res.status}.`);
  }
  const opener = new ResponseOpener(responseKey);
  let head: ResponseHead | null = null;
  const chunks: Uint8Array[] = [];
  for (const f of await opener.push(new Uint8Array(await res.arrayBuffer()))) {
    if (f.kind === "head") head = f.head;
    else if (f.kind === "data") chunks.push(f.data);
  }
  if (!head || !opener.finished) throw new Error("The response was cut off before it finished.");
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { status: head.status, headers: head.headers, text: new TextDecoder().decode(all) };
}

export async function callJson<T>(device: Device, method: string, path: string, body?: unknown): Promise<T> {
  const a = await call(device, method, path, body);
  let parsed: unknown = null;
  try {
    parsed = a.text ? JSON.parse(a.text) : null;
  } catch {
    // Not JSON: reported below with the status.
  }
  if (a.status < 200 || a.status >= 300) throw new Error((parsed as { error?: string } | null)?.error ?? `${method} ${path} answered ${a.status}.`);
  return parsed as T;
}
