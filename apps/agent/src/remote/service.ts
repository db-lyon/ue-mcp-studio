/**
 * What the computer does with a call the relay delivers: an enrollment from a
 * browser that scanned this computer's code, or a sealed request from a paired
 * browser, opened here, checked against remotePath, run against the daemon and
 * sealed back.
 */
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  MAX_REQUEST_BYTES,
  PAIR_SECRET_TTL_MS,
  ReplayGuard,
  ResponseSealer,
  b64u,
  openRequest,
  randomBytes,
  remotePath,
  verifyPairingMac,
  type EnrollRequest,
  type PlainRequest,
  type SealedRequest,
} from "@ue-mcp-studio/remote";
import type { ComputerKeys } from "./keys.js";

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
}

/** Large daemon responses are sealed in pieces this size. */
const FRAME_BYTES = 256 * 1024;

export class RemoteService {
  private readonly pending = new Map<string, number>();
  private readonly guard = new ReplayGuard();
  private readonly calls = new Map<string, Set<AbortController>>();

  constructor(private readonly o: ServiceOptions) {}

  /** A one-time pairing secret for a QR code. Only this process can redeem it. */
  newPairingSecret(): string {
    const now = Date.now();
    for (const [s, until] of this.pending) if (until < now) this.pending.delete(s);
    const secret = b64u(randomBytes(32));
    this.pending.set(secret, now + PAIR_SECRET_TTL_MS);
    return secret;
  }

  /** End the calls a browser has open here, its event stream included. Revoking it stops new ones. */
  cutOff(phoneId: string): void {
    for (const c of this.calls.get(phoneId) ?? []) c.abort();
    this.calls.delete(phoneId);
  }

  async enroll(body: string, sink: CallSink): Promise<void> {
    let e: Partial<EnrollRequest>;
    try {
      e = JSON.parse(body) as Partial<EnrollRequest>;
    } catch {
      return sink.fail(400, "Malformed enrollment.");
    }
    if (typeof e.phonePublic !== "string" || typeof e.mac !== "string") return sink.fail(400, "Malformed enrollment.");
    const me = await this.o.keys.identity();
    const now = Date.now();
    for (const [secret, until] of this.pending) {
      if (until < now) continue;
      if (await verifyPairingMac(secret, e.phonePublic, me.publicKey, e.mac)) {
        this.pending.delete(secret);
        const phone = await this.o.keys.addPhone(e.phonePublic, typeof e.label === "string" ? e.label : "Browser");
        sink.head(200, { "content-type": "application/json" });
        await sink.chunk(new TextEncoder().encode(JSON.stringify({ phoneId: phone.id, computerPublic: me.publicKey })));
        return sink.end();
      }
    }
    sink.fail(403, "That pairing code is used, expired, or for another computer. Make a new one.");
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
    if (!secret) return sink.fail(403, "This browser is not paired with that computer. Scan its pairing code again.");
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
    const daemon = this.o.daemon();
    if (!daemon) return error(503, "The daemon is not running for that project.");
    const reqBody = req.body !== undefined ? Buffer.from(req.body, "base64") : undefined;
    if (reqBody && reqBody.byteLength > MAX_REQUEST_BYTES) return error(413, "Request too large.");
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
    try {
      await sink.chunk(await sealer.head({ status: res.status, headers: out }));
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
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
}

function forwardHeaders(req: PlainRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers?.[h];
    if (typeof v === "string") out[h] = v;
  }
  return out;
}
