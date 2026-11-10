/**
 * What the computer does with a call the relay delivers: an enrollment from a
 * browser that scanned this computer's code, or a sealed request from a paired
 * browser, opened here, checked against remotePath, run against the daemon and
 * sealed back.
 */
import {
  ACCEPT_GZIP,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  MAX_REQUEST_BYTES,
  PAIR_APPROVAL_TTL_MS,
  PAIR_SECRET_TTL_MS,
  ReplayGuard,
  ResponseSealer,
  b64u,
  listedPairingCode,
  openRequest,
  pairCommit,
  pairingCode,
  randomBytes,
  remoteBodyAllowed,
  remotePath,
  verifyPairingMac,
  type EnrollListed,
  type EnrollPending,
  type EnrollRequest,
  type PlainRequest,
  type SealedRequest,
} from "@ue-mcp-studio/remote";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ComputerKeys, PairedPhone } from "./keys.js";
import { LOCK_PATH, type PinLock } from "./pin-lock.js";

/** Where a call's answer goes. `chunk` resolves once the bytes may be sent on. */
export interface CallSink {
  head(status: number, headers: Record<string, string>): void;
  chunk(bytes: Uint8Array): Promise<void>;
  end(): void;
  fail(status: number, error: string): void;
}

export interface ServiceOptions {
  keys: ComputerKeys;
  deviceId: string;
  daemon: () => { port: number; token: string } | null;
  /** Where the secrets of pairing codes still on screen are kept, so a daemon restart does not void them. Memory only when absent. */
  pendingFile?: string;
  /** A browser asks to be allowed; the owner answers with decide(). */
  onApproval?: (a: PairingApproval) => void;
  /** The owner allowed a browser and it is paired now. */
  onPaired?: (phone: PairedPhone) => void;
  now?: () => number;
  /** Silence on an event stream before a keepalive comment goes out. Default STREAM_KEEPALIVE_MS. */
  keepaliveMs?: number;
  /** The remote PIN lock; no lock when absent. */
  lock?: PinLock;
  /** Whether shell commands or file changes run without asking, so any turn could run them. */
  risky?: () => boolean;
  /** A browser was removed for too many wrong PINs. */
  onLockout?: (phone: PairedPhone) => void;
}

/** A browser that proved it read this computer's code, waiting for the owner to allow it. */
export interface PairingApproval {
  id: string;
  label: string;
  /** Six digits; the browser shows the same ones. */
  code: string;
  expiresAt: string;
}

interface Approval extends PairingApproval {
  phonePublic: string;
  /** "committed": a pairing from the list waiting for the client to reveal its nonce; not shown to the owner yet. */
  state: "committed" | "pending" | "allowed" | "denied";
  phoneId?: string;
  /** A pairing from the list: the client's commitment and this computer's nonce. */
  commit?: string;
  nonce?: string;
}

/** 32 bytes as unpadded base64url: a nonce, or the commitment to one. */
const B64U_32 = /^[\w-]{43}$/;

/** How long a decided approval is kept so the browser's next poll still learns the answer. */
const DECIDED_KEEP_MS = 5 * 60_000;

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** An event stream with nothing to say for this long gets a comment line, so no proxy closes it as idle. */
export const STREAM_KEEPALIVE_MS = 20_000;
const KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");

/** Large bodies are sealed in frames this size, small enough that a frame of one call never holds another's for long on a slow upload. */
const FRAME_BYTES = 32 * 1024;

export class RemoteService {
  private readonly approvals = new Map<string, Approval>();
  private memory: Record<string, number> = {};
  private readonly guard = new ReplayGuard();
  private readonly calls = new Map<string, Set<AbortController>>();

  constructor(private readonly o: ServiceOptions) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** The secrets of codes still on screen and unexpired, from disk when there is a file. */
  private secrets(): Map<string, number> {
    let saved: Record<string, number> = this.memory;
    if (this.o.pendingFile) {
      try {
        saved = JSON.parse(fs.readFileSync(this.o.pendingFile, "utf-8")) as Record<string, number>;
      } catch {
        saved = {};
      }
    }
    const now = this.now();
    return new Map(Object.entries(saved).filter(([, until]) => typeof until === "number" && until > now));
  }

  private saveSecrets(m: Map<string, number>): void {
    const obj = Object.fromEntries(m);
    if (this.o.pendingFile) writePrivate(this.o.pendingFile, obj);
    else this.memory = obj;
  }

  /** A one-time pairing secret for a QR code, kept until it is used or expires, so a daemon restart does not void a code on screen. */
  newPairingSecret(): string {
    const m = this.secrets();
    const secret = b64u(randomBytes(32));
    m.set(secret, this.now() + PAIR_SECRET_TTL_MS);
    this.saveSecrets(m);
    return secret;
  }

  /** Browsers waiting for the owner, oldest first. */
  pendingApprovals(): PairingApproval[] {
    const now = this.now();
    return [...this.approvals.values()]
      .filter((a) => a.state === "pending" && Date.parse(a.expiresAt) > now)
      .map(({ id, label, code, expiresAt }) => ({ id, label, code, expiresAt }));
  }

  /** The owner's answer. Only a pending, unexpired request can be allowed; the browser learns it on its next poll. */
  async decide(id: string, allow: boolean): Promise<{ ok: true; phone?: PairedPhone } | { ok: false; error: string }> {
    const a = this.approvals.get(id);
    if (!a || a.state !== "pending") return { ok: false, error: "That request is no longer waiting." };
    if (Date.parse(a.expiresAt) <= this.now()) {
      a.state = "denied";
      return { ok: false, error: "That request ran out of time. Make a new code." };
    }
    if (!allow) {
      a.state = "denied";
      return { ok: true };
    }
    const phone = await this.o.keys.addPhone(a.phonePublic, a.label);
    a.state = "allowed";
    a.phoneId = phone.id;
    this.o.onPaired?.(phone);
    return { ok: true, phone };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, a] of this.approvals) if (Date.parse(a.expiresAt) + DECIDED_KEEP_MS < now) this.approvals.delete(id);
  }

  /** End the calls a browser has open here, its event stream included. Revoking it stops new ones. */
  cutOff(phoneId: string): void {
    for (const c of this.calls.get(phoneId) ?? []) c.abort();
    this.calls.delete(phoneId);
  }

  /**
   * A browser that scanned this computer's code. Proving it read the code is not
   * enough: the code is spent and the browser waits (202) until the owner allows
   * it here. It asks again with { poll } until allowed (200), denied or timed out.
   */
  async enroll(body: string, sink: CallSink): Promise<void> {
    let e: Partial<EnrollRequest> & { poll?: unknown };
    try {
      e = JSON.parse(body) as Partial<EnrollRequest> & { poll?: unknown };
    } catch {
      return sink.fail(400, "Malformed enrollment.");
    }
    this.prune();
    if (typeof e.poll === "string") return this.answerPoll(e.poll, sink, typeof (e as { reveal?: unknown }).reveal === "string" ? (e as { reveal: string }).reveal : undefined);
    const listed = e as Partial<EnrollListed>;
    if (listed.listed === true) return this.enrollListed(listed, sink);
    if (typeof e.phonePublic !== "string" || typeof e.mac !== "string") return sink.fail(400, "Malformed enrollment.");
    const me = await this.o.keys.identity();
    const secrets = this.secrets();
    for (const secret of secrets.keys()) {
      if (await verifyPairingMac(secret, e.phonePublic, me.publicKey, e.mac)) {
        // Spent whatever the owner answers: a denied or timed-out browser needs a new code.
        secrets.delete(secret);
        this.saveSecrets(secrets);
        const approval: Approval = {
          id: b64u(randomBytes(16)),
          label: (typeof e.label === "string" ? e.label : "Browser").slice(0, 120) || "Browser",
          code: await pairingCode(secret, e.phonePublic),
          expiresAt: new Date(this.now() + PAIR_APPROVAL_TTL_MS).toISOString(),
          phonePublic: e.phonePublic,
          state: "pending",
        };
        this.approvals.set(approval.id, approval);
        this.o.onApproval?.({ id: approval.id, label: approval.label, code: approval.code, expiresAt: approval.expiresAt });
        const pending: EnrollPending = { approval: approval.id, expiresAt: approval.expiresAt };
        return this.json(sink, 202, pending);
      }
    }
    sink.fail(403, "That pairing code is used, expired, or for another computer. Make a new one.");
  }

  /**
   * A client already signed in to the account, pairing from the list without a
   * code. Nothing is shown yet: the computer answers with its nonce, and the
   * approval comes up once the client reveals the nonce it committed to.
   */
  private async enrollListed(e: Partial<EnrollListed>, sink: CallSink): Promise<void> {
    if (typeof e.phonePublic !== "string" || typeof e.commit !== "string" || !B64U_32.test(e.commit)) return sink.fail(400, "Malformed enrollment.");
    const approval: Approval = {
      id: b64u(randomBytes(16)),
      label: (typeof e.label === "string" ? e.label : "Browser").slice(0, 120) || "Browser",
      code: "",
      expiresAt: new Date(this.now() + PAIR_APPROVAL_TTL_MS).toISOString(),
      phonePublic: e.phonePublic,
      state: "committed",
      commit: e.commit,
      nonce: b64u(randomBytes(32)),
    };
    this.approvals.set(approval.id, approval);
    const pending: EnrollPending = { approval: approval.id, expiresAt: approval.expiresAt, nonce: approval.nonce };
    return this.json(sink, 202, pending);
  }

  private async answerPoll(id: string, sink: CallSink, reveal?: string): Promise<void> {
    const a = this.approvals.get(id);
    if (!a) return sink.fail(403, "The computer no longer knows this request. Make a new code.");
    if (a.state === "committed") {
      // The nonce must be the one committed to before this computer's was known; anything else ends the request.
      if (!reveal || !B64U_32.test(reveal) || (await pairCommit(reveal)) !== a.commit) {
        a.state = "denied";
        return sink.fail(403, "The pairing request did not check out. Try again.");
      }
      const me = await this.o.keys.identity();
      a.code = await listedPairingCode(a.phonePublic, me.publicKey, a.nonce!, reveal);
      a.state = "pending";
      this.o.onApproval?.({ id: a.id, label: a.label, code: a.code, expiresAt: a.expiresAt });
    }
    if (a.state === "allowed" && a.phoneId) {
      const me = await this.o.keys.identity();
      this.approvals.delete(id);
      return this.json(sink, 200, { phoneId: a.phoneId, computerPublic: me.publicKey });
    }
    if (a.state === "denied") return sink.fail(403, "The computer denied this device.");
    if (Date.parse(a.expiresAt) <= this.now()) {
      a.state = "denied";
      return sink.fail(403, `Nobody allowed this device on the computer within ${PAIR_APPROVAL_TTL_MS / 60_000} minutes. Make a new code.`);
    }
    const pending: EnrollPending = { approval: a.id, expiresAt: a.expiresAt };
    return this.json(sink, 202, pending);
  }

  private async json(sink: CallSink, status: number, value: unknown): Promise<void> {
    sink.head(status, { "content-type": "application/json" });
    await sink.chunk(new TextEncoder().encode(JSON.stringify(value)));
    sink.end();
  }

  async sealed(body: string, sink: CallSink, relaySignal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    relaySignal.addEventListener("abort", abort, { once: true });
    let phone: string | null = null;
    try {
      await this.run(body, sink, controller, (id) => {
        phone = id;
        this.calls.set(id, (this.calls.get(id) ?? new Set()).add(controller));
      });
    } finally {
      relaySignal.removeEventListener("abort", abort);
      if (phone) this.calls.get(phone)?.delete(controller);
    }
  }

  private async run(body: string, sink: CallSink, controller: AbortController, track: (phoneId: string) => void): Promise<void> {
    const signal = controller.signal;
    let sealed: SealedRequest;
    try {
      sealed = JSON.parse(body) as SealedRequest;
    } catch {
      return sink.fail(400, "Malformed request.");
    }
    const secret = typeof sealed.phone === "string" ? await this.o.keys.secretFor(sealed.phone) : null;
    if (!secret) return sink.fail(403, "This device is not paired with that computer. Pair it again with a new code.");
    const opened = await openRequest(secret, sealed);
    if (!opened) return sink.fail(403, "The request did not decrypt.");
    const { req, responseKey } = opened;
    if (!this.guard.accept(req.id, req.ts)) return sink.fail(403, "Replayed or stale request. Check this device's clock.");
    if (req.device !== this.o.deviceId) return sink.fail(403, "The request was meant for another project.");
    track(sealed.phone);

    // From here the browser is authenticated, so even refusals go back sealed.
    const sealer = new ResponseSealer(responseKey);
    sink.head(200, { "content-type": "application/octet-stream" });
    const reply = async (status: number, headers: Record<string, string>, payload?: Uint8Array): Promise<void> => {
      await sink.chunk(await sealer.head({ status, headers }));
      if (payload) await sink.chunk(await sealer.data(payload));
      await sink.chunk(await sealer.final());
      sink.end();
    };
    const error = (status: number, message: string) =>
      reply(status, { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify({ error: message })));

    const target = remotePath(req.method, req.path);
    if (!target) return error(403, "Not available remotely.");
    const pathname = target.split("?")[0];
    // The lock's own routes are answered here: only this side knows which browser is asking.
    if (pathname === LOCK_PATH || pathname.startsWith(`${LOCK_PATH}/`)) {
      const answer = await this.lockRoute(sealed.phone, req.method, pathname, req.body);
      return reply(answer.status, { "content-type": "application/json", "cache-control": "no-store" }, new TextEncoder().encode(JSON.stringify(answer.body)));
    }
    const reqBody = req.body !== undefined ? Buffer.from(req.body, "base64") : undefined;
    if (reqBody && reqBody.byteLength > MAX_REQUEST_BYTES) return error(413, "Request too large.");
    if (this.o.lock) {
      const verdict = this.o.lock.check(sealed.phone, req.method, pathname, this.o.risky?.() ?? true, reqBody);
      if (verdict === "locked") return reply(423, { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify({ error: "Locked. Enter your PIN.", code: "locked" })));
      if (verdict === "pin-required") return reply(423, { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify({ error: "Enter your PIN to do this.", code: "pin-required" })));
      if (req.method !== "GET" && req.method !== "HEAD") this.o.lock.touch(sealed.phone);
    }
    if (!remoteBodyAllowed(req.method, pathname, reqBody)) return error(403, "Not available remotely.");
    const daemon = this.o.daemon();
    if (!daemon) return error(503, "The daemon is not running for that project.");
    const headers = forwardHeaders(req);
    headers["authorization"] = `Bearer ${daemon.token}`;

    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${daemon.port}${target}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : reqBody,
        signal,
        redirect: "manual",
      });
    } catch (e) {
      if (signal.aborted) return sink.end();
      return error(502, e instanceof Error ? e.message : String(e));
    }
    const out: Record<string, string> = {};
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) out[h] = v;
    }
    const location = res.headers.get("location");
    if (location && location.startsWith("/")) out["location"] = location;
    // A browser that opens gzip itself gets text compressed before sealing; event streams stay as they are, chunk by chunk.
    const gzip = !!res.body && req.accept?.includes(ACCEPT_GZIP) === true && compressible(out["content-type"]);
    if (gzip) out["content-encoding"] = "gzip";
    try {
      await sink.chunk(await sealer.head({ status: res.status, headers: out }));
      if (res.body) {
        const body = gzip ? res.body.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : res.body;
        const reader = body.getReader();
        // An event stream can sit silent for minutes; a comment line every so often keeps proxies on the way from closing it as idle.
        const stream = (out["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "text/event-stream";
        let next = reader.read();
        // A cut-off call rejects the read in flight while a write is awaited: handled here, rethrown where it is awaited.
        next.catch(() => undefined);
        for (;;) {
          let timer: NodeJS.Timeout | undefined;
          const idle = stream ? new Promise<"idle">((r) => (timer = setTimeout(() => r("idle"), this.o.keepaliveMs ?? STREAM_KEEPALIVE_MS))) : null;
          const got = idle ? await Promise.race([next, idle]) : await next;
          if (timer) clearTimeout(timer);
          if (got === "idle") {
            await sink.chunk(await sealer.data(KEEPALIVE));
            continue;
          }
          if (got.done) break;
          next = reader.read();
          next.catch(() => undefined);
          const value = got.value;
          for (let i = 0; i < value.byteLength; i += FRAME_BYTES) await sink.chunk(await sealer.data(value.subarray(i, i + FRAME_BYTES)));
        }
      }
      await sink.chunk(await sealer.final());
      sink.end();
    } catch (e) {
      // The browser sees a response with no final frame and reports it as cut off.
      if (!signal.aborted) sink.fail(502, e instanceof Error ? e.message : String(e));
      else sink.end();
    }
  }
  /** GET .../lock, POST .../lock/unlock { pin }, .../lock/touch and .../lock/lock, for the browser `phone`. */
  private async lockRoute(phone: string, method: string, pathname: string, body: string | undefined): Promise<{ status: number; body: unknown }> {
    const lock = this.o.lock;
    const sub = pathname.slice(LOCK_PATH.length);
    const off = { whole: false, sensitive: false, locked: false, sensitiveOpen: true, idleMinutes: 0 };
    if (method === "GET" && sub === "") return { status: 200, body: lock ? lock.state(phone) : off };
    if (method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
    if (!lock) return { status: 409, body: { error: "No PIN is set on the computer." } };
    if (sub === "/touch") {
      lock.touch(phone);
      return { status: 200, body: lock.state(phone) };
    }
    if (sub === "/lock") {
      lock.lock(phone);
      return { status: 200, body: lock.state(phone) };
    }
    if (sub !== "/unlock") return { status: 404, body: { error: "Not found." } };
    let pin: unknown;
    try {
      pin = (JSON.parse(body ? Buffer.from(body, "base64").toString("utf-8") : "{}") as { pin?: unknown }).pin;
    } catch {
      pin = undefined;
    }
    const r = await lock.unlock(phone, pin);
    if (r.ok) return { status: 200, body: r.state };
    if (r.unpaired) {
      const removed = this.o.keys.phones().find((p) => p.id === phone);
      this.o.keys.removePhone(phone);
      lock.forget(phone);
      if (removed) this.o.onLockout?.(removed);
      // Its open calls end after this answer, the event stream included.
      setTimeout(() => this.cutOff(phone), 0);
    }
    const { status, error, retryAfterMs, remaining, unpaired } = r;
    return { status, body: { error, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(remaining !== undefined ? { remaining } : {}), ...(unpaired ? { unpaired: true } : {}) } };
  }
}

/** Text worth compressing: JSON, scripts, styles, markup. Images, archives and event streams are not. */
export function compressible(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const t = contentType.split(";")[0].trim().toLowerCase();
  if (t === "text/event-stream") return false;
  return t.startsWith("text/") || t === "application/json" || t === "application/javascript" || t === "image/svg+xml" || t.endsWith("+json");
}

function forwardHeaders(req: PlainRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers?.[h];
    if (typeof v === "string") out[h] = v;
  }
  return out;
}
