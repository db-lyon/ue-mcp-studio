/**
 * The remote PIN lock, as a paired client meets it. The computer enforces it:
 * a refused request answers 423 with code "locked" (the whole client is locked)
 * or "pin-required" (a sensitive action). This puts the lock screen or the PIN
 * prompt in front of the owner and sends the request again once the PIN is in.
 *
 * `guard` wraps a Transport so no caller handles the lock itself.
 */
import type { Reply, Transport } from "./transport.js";
import { readAll, readJson } from "./transport.js";

export const LOCK_PATH = "/v1/ext/studio/lock";
/** Report the owner's touches at most this often, which keeps an unlocked client open. */
export const TOUCH_EVERY_MS = 30_000;

export interface LockState {
  whole: boolean;
  sensitive: boolean;
  locked: boolean;
  sensitiveOpen: boolean;
  idleMinutes: number;
  remaining?: number;
  retryAfterMs?: number;
  pinLength?: number;
}

export interface LockView {
  state: LockState | null;
  /** The whole client is locked: the lock screen covers everything. */
  screen: boolean;
  /** A sensitive action waits for the PIN. */
  prompt: boolean;
  /** This client was removed for too many wrong PINs. */
  removed: boolean;
}

export type UnlockAnswer = { ok: true } | { ok: false; error: string; retryAfterMs?: number; remaining?: number; removed?: boolean };

export interface Lock {
  view(): LockView;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<LockState | null>;
  unlock(pin: string): Promise<UnlockAnswer>;
  cancelPrompt(): void;
  lockNow(): Promise<void>;
  /** The owner used the app; sent at most every TOUCH_EVERY_MS. */
  touched(): void;
  /** The transport, with locked requests held until the PIN is in and then sent again. */
  guard(transport: Transport): Transport;
}

function replyOf(status: number, headers: Record<string, string>, bytes: Uint8Array): Reply {
  return {
    status,
    headers,
    body: (async function* () {
      if (bytes.length) yield bytes;
    })(),
  };
}

export function createLock(transport: Transport, now: () => number = () => Date.now()): Lock {
  let view: LockView = { state: null, screen: false, prompt: false, removed: false };
  const listeners = new Set<() => void>();
  const unlockWaiters: Array<(ok: boolean) => void> = [];
  const promptWaiters: Array<(ok: boolean) => void> = [];
  let lastTouch = 0;

  const set = (next: Partial<LockView>): void => {
    view = { ...view, ...next };
    listeners.forEach((l) => l());
  };
  const settle = (waiters: Array<(ok: boolean) => void>, ok: boolean): void => {
    for (const w of waiters.splice(0)) w(ok);
  };
  const call = async (method: "GET" | "POST", sub = "", json?: unknown) => {
    const reply = await transport(method, `${LOCK_PATH}${sub}`, json !== undefined ? { json } : {});
    return { status: reply.status, body: await readJson<Record<string, unknown>>(reply) };
  };

  const refresh = async (): Promise<LockState | null> => {
    try {
      const r = await call("GET");
      if (r.status !== 200) return view.state;
      const state = r.body as unknown as LockState;
      set({ state, screen: state.locked });
      if (!state.locked) settle(unlockWaiters, true);
      return state;
    } catch {
      return view.state;
    }
  };

  const wait = (waiters: Array<(ok: boolean) => void>, signal?: AbortSignal): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const done = (ok: boolean): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onAbort = (): void => {
        const i = waiters.indexOf(done);
        if (i >= 0) waiters.splice(i, 1);
        const e = new Error("The request was aborted.");
        e.name = "AbortError";
        reject(e);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(done);
    });

  const lock: Lock = {
    view: () => view,
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    refresh,
    async unlock(pin) {
      let r: { status: number; body: Record<string, unknown> };
      try {
        r = await call("POST", "/unlock", { pin });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (r.status === 200) {
        set({ state: r.body as unknown as LockState, screen: false, prompt: false });
        settle(unlockWaiters, true);
        settle(promptWaiters, true);
        return { ok: true };
      }
      const b = r.body as { error?: string; retryAfterMs?: number; remaining?: number; unpaired?: boolean };
      if (b.unpaired) {
        set({ removed: true, screen: true, prompt: false });
        settle(promptWaiters, false);
      } else if (view.state) {
        set({ state: { ...view.state, ...(b.remaining !== undefined ? { remaining: b.remaining } : {}), ...(b.retryAfterMs !== undefined ? { retryAfterMs: b.retryAfterMs } : {}) } });
      }
      return { ok: false, error: b.error ?? `HTTP ${r.status}`, retryAfterMs: b.retryAfterMs, remaining: b.remaining, removed: b.unpaired };
    },
    cancelPrompt() {
      set({ prompt: false });
      settle(promptWaiters, false);
    },
    async lockNow() {
      await call("POST", "/lock").catch(() => undefined);
      await refresh();
    },
    touched() {
      const s = view.state;
      if (!s?.whole || s.locked || view.screen) return;
      if (now() - lastTouch < TOUCH_EVERY_MS) return;
      lastTouch = now();
      void call("POST", "/touch").then((r) => {
        if (r.status !== 200) return;
        const state = r.body as unknown as LockState;
        set({ state, screen: state.locked });
      }, () => undefined);
    },
    guard(inner) {
      const guarded: Transport = async (method, path, options = {}) => {
        const reply = await inner(method, path, options);
        if (reply.status !== 423 || path.startsWith(LOCK_PATH)) return reply;
        const bytes = await readAll(reply);
        let code: unknown;
        try {
          code = (JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown }).code;
        } catch {
          code = undefined;
        }
        if (code !== "locked" && code !== "pin-required") return replyOf(reply.status, reply.headers, bytes);
        let ok: boolean;
        if (code === "locked") {
          set({ screen: true, prompt: false });
          void refresh();
          ok = await wait(unlockWaiters, options.signal);
        } else {
          set({ prompt: true });
          ok = await wait(promptWaiters, options.signal);
        }
        return ok ? guarded(method, path, options) : replyOf(reply.status, reply.headers, bytes);
      };
      return guarded;
    },
  };
  return lock;
}
