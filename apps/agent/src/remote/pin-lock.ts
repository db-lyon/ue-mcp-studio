/**
 * The remote PIN lock: opt-in, set in Studio on the computer, enforced here on
 * the computer for every sealed request, because a paired browser holds keys
 * that can send requests without the page. Two switches, either or both:
 * `whole` locks the paired browser until the PIN is entered and again after
 * it sits idle; `sensitive` asks for the PIN at the moment of a sensitive
 * action (sensitiveRequest) and lets that browser do them for a short while.
 *
 * One file per computer, beside the paired browsers (<ue-mcp user dir>/remote/
 * remote-lock.json, 0600): a salted scrypt hash of the PIN, the switches, and
 * each browser's wrong-PIN count, so a restart neither forgets the count nor
 * keeps anyone unlocked. Unlocks live only in this process's memory: a daemon
 * restart locks every browser again.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REMOTE_LOCK_IDLE_CHOICES,
  REMOTE_LOCK_IDLE_DEFAULT,
  REMOTE_PIN_ATTEMPTS,
  type RemoteLockSettings,
  type RemoteLockState,
} from "@ue-mcp-studio/shared";

/** The phone-facing lock routes, answered by the connector itself and never forwarded to the daemon. */
export const LOCK_PATH = "/v1/ext/studio/lock";

/** How long a PIN entered for a sensitive action lets that browser do more of them. */
export const SENSITIVE_GRANT_MS = 5 * 60_000;

/** A PIN is 4 to 8 digits. */
export const PIN_PATTERN = /^\d{4,8}$/;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;

interface Stored {
  v: 1;
  salt?: string;
  hash?: string;
  /** The PIN's digit count, for the keypad. */
  length?: number;
  whole: boolean;
  sensitive: boolean;
  idleMinutes: number;
  /** Wrong PINs in a row, per paired browser. */
  failures: Record<string, number>;
}

const EMPTY: Stored = { v: 1, whole: false, sensitive: false, idleMinutes: REMOTE_LOCK_IDLE_DEFAULT, failures: {} };

/**
 * The wait before the next try after this many wrong PINs in a row: none for
 * the first three, then doubling from 2 seconds. The tenth unpairs the browser.
 */
export function attemptDelayMs(failures: number): number {
  if (failures < 4) return 0;
  return Math.min(2000 * 2 ** (failures - 4), 5 * 60_000);
}

/** Routes a whole-client lock still lets through: the page, the connection check, and the way to unlock. */
export function openWhileLocked(method: string, pathname: string): boolean {
  if (pathname === LOCK_PATH || pathname.startsWith(`${LOCK_PATH}/`)) return true;
  if (method.toUpperCase() !== "GET") return false;
  return pathname === "/v1/health" || pathname === "/ui" || pathname.startsWith("/ui/");
}

const STUDIO = "/v1/ext/studio";

/** Studio routes that start the agent on a turn: sensitive only while shell commands or file changes run without asking. */
const TURN_ROUTES: RegExp[] = [
  /^\/sessions\/[^/]+\/messages$/,
  /^\/sessions\/[^/]+\/queue(\/next|\/[^/]+)?$/,
  /^\/sessions\/[^/]+\/transcript\/[^/]+\/edit$/,
  /^\/sessions\/[^/]+\/action$/,
  /^\/sessions\/[^/]+\/flow$/,
  /^\/quick(\/[^/]+\/continue)?$/,
];

/** Studio routes that are always sensitive: answering approvals and editor dialogs, undoing or reverting changes, running playtests, settings, sign-ins, updates and billing. */
const ALWAYS_ROUTES: RegExp[] = [
  /^\/sessions\/[^/]+\/approvals\/[^/]+$/,
  /^\/dialogs\/[^/]+$/,
  /^\/forms\/[^/]+$/,
  /^\/sessions\/[^/]+\/reviews\/[^/]+\/(keep|revert|undo)$/,
  /^\/sessions\/[^/]+\/timeline\/(restore|undo)$/,
  /^\/sessions\/[^/]+\/playtest$/,
  /^\/qa\/runs\/[^/]+\/(run|loop\/revert)$/,
  /^\/qa\/playtests\/script$/,
  /^\/qa\/runs\/[^/]+\/script$/,
  /^\/settings$/,
  /^\/agent-settings$/,
  /^\/config$/,
  /^\/context-strategy$/,
  /^\/endpoints(\/.*)?$/,
  /^\/signin\/[^/]+$/,
  /^\/updates(\/.*)?$/,
  /^\/version-notice\/(keep|update)$/,
  /^\/refusal\/update$/,
  /^\/billing\//,
  /^\/busy\/stop$/,
];

/**
 * Whether `method pathname` (a daemon path a paired browser may reach, see
 * remotePath) needs the PIN under the sensitive-actions switch. Reads never do.
 * `risky`: shell commands or file changes run without asking, so any turn the
 * request starts could run them.
 */
export function sensitiveRequest(method: string, pathname: string, risky: boolean): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  if (/^\/v1\/editor\/(start|stop|restart|rebuild)$/.test(pathname)) return true;
  if (pathname === "/v1/flows" || pathname.startsWith("/v1/flows/")) return true;
  if (!pathname.startsWith(`${STUDIO}/`)) return false;
  const rest = pathname.slice(STUDIO.length);
  if (rest === "/lock" || rest.startsWith("/lock/")) return false;
  // Deleting a session; renaming one is not.
  if (m === "DELETE" && /^\/sessions\/[^/]+$/.test(rest)) return true;
  if (ALWAYS_ROUTES.some((r) => r.test(rest))) return true;
  return risky && TURN_ROUTES.some((r) => r.test(rest));
}

export type LockVerdict = "ok" | "locked" | "pin-required";

export type UnlockResult =
  | { ok: true; state: RemoteLockState }
  | { ok: false; status: number; error: string; retryAfterMs?: number; remaining?: number; unpaired?: boolean };

interface Grant {
  /** The whole client stays open while the browser was active within the idle time. */
  lastActive: number;
  /** Sensitive actions are open until then. */
  sensitiveUntil: number;
}

function hash(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(pin, salt, KEY_BYTES, SCRYPT, (e, key) => (e ? reject(e) : resolve(key))));
}

export interface PinLockOptions {
  /** remote-lock.json, beside the paired browsers. */
  file: string;
  now?: () => number;
}

export class PinLock {
  private readonly grants = new Map<string, Grant>();
  /** Not before then may this browser try again. */
  private readonly nextTry = new Map<string, number>();
  private cache: { mtime: number; stored: Stored } | null = null;

  constructor(private readonly o: PinLockOptions) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** Read fresh when the file changed, so a PIN set in one project's Studio locks the others. */
  private stored(): Stored {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.o.file).mtimeMs;
    } catch {
      this.cache = null;
      return { ...EMPTY, failures: {} };
    }
    if (this.cache?.mtime !== mtime) {
      let raw: Partial<Stored> = {};
      try {
        raw = JSON.parse(fs.readFileSync(this.o.file, "utf-8")) as Partial<Stored>;
      } catch {
        raw = {};
      }
      const idle = REMOTE_LOCK_IDLE_CHOICES.includes(raw.idleMinutes as number) ? (raw.idleMinutes as number) : REMOTE_LOCK_IDLE_DEFAULT;
      const pin = typeof raw.salt === "string" && typeof raw.hash === "string";
      const length = pin && Number.isInteger(raw.length) && (raw.length as number) >= 4 && (raw.length as number) <= 8 ? (raw.length as number) : undefined;
      this.cache = {
        mtime,
        stored: {
          v: 1,
          ...(pin ? { salt: raw.salt, hash: raw.hash } : {}),
          ...(length ? { length } : {}),
          whole: pin && raw.whole === true,
          sensitive: pin && raw.sensitive === true,
          idleMinutes: idle,
          failures: raw.failures && typeof raw.failures === "object" ? { ...raw.failures } : {},
        },
      };
    }
    return { ...this.cache.stored, failures: { ...this.cache.stored.failures } };
  }

  private save(s: Stored): void {
    fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
    const tmp = `${this.o.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.o.file);
    this.cache = null;
  }

  /** What Settings shows on the computer. */
  settings(): RemoteLockSettings {
    const s = this.stored();
    return { pin: !!s.hash, whole: s.whole, sensitive: s.sensitive, idleMinutes: s.idleMinutes };
  }

  /** Set or change the PIN. Every browser is locked again. */
  async setPin(pin: string): Promise<void> {
    if (!PIN_PATTERN.test(pin)) throw new Error("A PIN is 4 to 8 digits.");
    const salt = crypto.randomBytes(16);
    const key = await hash(pin, salt);
    const s = this.stored();
    this.save({ ...s, salt: salt.toString("base64"), hash: key.toString("base64"), length: pin.length, failures: {} });
    this.grants.clear();
    this.nextTry.clear();
  }

  /** Remove the PIN, which turns both switches off. */
  removePin(): void {
    const s = this.stored();
    this.save({ v: 1, whole: false, sensitive: false, idleMinutes: s.idleMinutes, failures: {} });
    this.grants.clear();
    this.nextTry.clear();
  }

  /** Turn the switches on or off, or change the idle time. Either switch needs a PIN first. */
  configure(c: Partial<Pick<RemoteLockSettings, "whole" | "sensitive" | "idleMinutes">>): RemoteLockSettings {
    const s = this.stored();
    if ((c.whole || c.sensitive) && !s.hash) throw new Error("Set a PIN first.");
    if (c.idleMinutes !== undefined && !REMOTE_LOCK_IDLE_CHOICES.includes(c.idleMinutes)) throw new Error(`The idle time is one of ${REMOTE_LOCK_IDLE_CHOICES.join(", ")} minutes.`);
    this.save({
      ...s,
      ...(c.whole !== undefined ? { whole: c.whole } : {}),
      ...(c.sensitive !== undefined ? { sensitive: c.sensitive } : {}),
      ...(c.idleMinutes !== undefined ? { idleMinutes: c.idleMinutes } : {}),
    });
    return this.settings();
  }

  private open(phone: string, s: Stored): { whole: boolean; sensitive: boolean } {
    const g = this.grants.get(phone);
    const now = this.now();
    const whole = !s.whole || (!!g && now - g.lastActive < s.idleMinutes * 60_000);
    // A whole client that relocked takes the sensitive grant with it.
    const sensitive = !s.sensitive || (!!g && whole && now < g.sensitiveUntil);
    if (g && !whole) this.grants.delete(phone);
    return { whole, sensitive };
  }

  /** What a paired browser shows: whether it is locked, and what the PIN guards. */
  state(phone: string): RemoteLockState {
    const s = this.stored();
    const open = this.open(phone, s);
    const failures = s.failures[phone] ?? 0;
    const wait = Math.max(0, (this.nextTry.get(phone) ?? 0) - this.now());
    return {
      whole: s.whole,
      sensitive: s.sensitive,
      locked: !open.whole,
      sensitiveOpen: open.sensitive,
      idleMinutes: s.idleMinutes,
      ...(failures > 0 ? { remaining: REMOTE_PIN_ATTEMPTS - failures } : {}),
      ...(wait > 0 ? { retryAfterMs: wait } : {}),
      ...(s.hash && s.length ? { pinLength: s.length } : {}),
    };
  }

  /** Whether this request from this browser may go on. `risky`: see sensitiveRequest. */
  check(phone: string, method: string, pathname: string, risky: boolean): LockVerdict {
    const s = this.stored();
    if (!s.whole && !s.sensitive) return "ok";
    const open = this.open(phone, s);
    if (!open.whole && !openWhileLocked(method, pathname)) return "locked";
    if (!open.sensitive && sensitiveRequest(method, pathname, risky)) return "pin-required";
    return "ok";
  }

  /** The browser was used: a write, or the page saying its owner touched it. Keeps an unlocked whole client open. */
  touch(phone: string): void {
    const g = this.grants.get(phone);
    if (!g) return;
    const s = this.stored();
    if (this.open(phone, s).whole) g.lastActive = this.now();
  }

  /** Lock this browser now. */
  lock(phone: string): void {
    this.grants.delete(phone);
  }

  /**
   * A PIN from a paired browser. Right: the whole client opens until it sits
   * idle and sensitive actions open for SENSITIVE_GRANT_MS. Wrong: a growing
   * wait, and at REMOTE_PIN_ATTEMPTS in a row `unpaired`, for the caller to
   * remove the browser.
   */
  async unlock(phone: string, pin: unknown): Promise<UnlockResult> {
    const s = this.stored();
    if (!s.hash || !s.salt) return { ok: false, status: 409, error: "No PIN is set on the computer." };
    const wait = (this.nextTry.get(phone) ?? 0) - this.now();
    if (wait > 0) return { ok: false, status: 429, error: "Too many wrong PINs. Wait before trying again.", retryAfterMs: wait, remaining: REMOTE_PIN_ATTEMPTS - (s.failures[phone] ?? 0) };
    const given = typeof pin === "string" && PIN_PATTERN.test(pin) ? await hash(pin, Buffer.from(s.salt, "base64")) : null;
    const right = !!given && crypto.timingSafeEqual(given, Buffer.from(s.hash, "base64"));
    // Read again after the slow hash: another try may have counted meanwhile.
    const fresh = this.stored();
    if (right) {
      // A PIN set before its length was kept learns it here.
      const learn = fresh.length !== (pin as string).length;
      if (fresh.failures[phone] || learn) {
        delete fresh.failures[phone];
        this.save({ ...fresh, length: (pin as string).length });
      }
      this.nextTry.delete(phone);
      const now = this.now();
      this.grants.set(phone, { lastActive: now, sensitiveUntil: now + SENSITIVE_GRANT_MS });
      return { ok: true, state: this.state(phone) };
    }
    const failures = (fresh.failures[phone] ?? 0) + 1;
    if (failures >= REMOTE_PIN_ATTEMPTS) {
      delete fresh.failures[phone];
      this.save(fresh);
      this.grants.delete(phone);
      this.nextTry.delete(phone);
      return { ok: false, status: 403, error: `Wrong PIN ${REMOTE_PIN_ATTEMPTS} times. This browser was removed; pair it again from the computer.`, unpaired: true, remaining: 0 };
    }
    fresh.failures[phone] = failures;
    this.save(fresh);
    const delay = attemptDelayMs(failures);
    if (delay > 0) this.nextTry.set(phone, this.now() + delay);
    return { ok: false, status: 401, error: "Wrong PIN.", remaining: REMOTE_PIN_ATTEMPTS - failures, ...(delay > 0 ? { retryAfterMs: delay } : {}) };
  }

  /** Forget a browser that was removed. */
  forget(phone: string): void {
    this.grants.delete(phone);
    this.nextTry.delete(phone);
    const s = this.stored();
    if (s.failures[phone] !== undefined) {
      delete s.failures[phone];
      this.save(s);
    }
  }
}
