/**
 * The remote PIN lock, as a paired browser's page meets it. The computer
 * enforces it (a refused request answers 423 with code "locked" or
 * "pin-required"); this module only puts the lock screen or the PIN sheet in
 * front of the owner and sends the request again once the PIN is in.
 *
 * installLockGuard wraps fetch: a request the computer locked waits for the
 * PIN and then goes again, so no caller handles the lock itself. A request
 * whose body cannot be sent twice comes back with its 423 instead.
 */
import type { RemoteLockCode, RemoteLockState } from "@ue-mcp-studio/shared";

export const LOCK_URL = "/v1/ext/studio/lock";
/** The page tells the computer its owner touched it at most this often, which keeps an unlocked browser open. */
export const TOUCH_EVERY_MS = 30_000;

export interface LockView {
  state: RemoteLockState | null;
  /** The whole client is locked: the lock screen covers Studio. */
  screen: boolean;
  /** A sensitive action waits for the PIN sheet. */
  prompt: boolean;
  /** The browser was removed for too many wrong PINs. */
  removed: boolean;
}

let view: LockView = { state: null, screen: false, prompt: false, removed: false };
const listeners = new Set<() => void>();
let unlockWaiters: Array<(ok: boolean) => void> = [];
let promptWaiters: Array<(ok: boolean) => void> = [];
let raw: typeof fetch = (...a) => fetch(...a);
let installed = false;

function set(next: Partial<LockView>): void {
  view = { ...view, ...next };
  listeners.forEach((l) => l());
}

export function lockView(): LockView {
  return view;
}

export function subscribeLock(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

async function lockCall(method: "GET" | "POST", sub = "", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await raw(`${LOCK_URL}${sub}`, {
    method,
    credentials: "same-origin",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

function settle(waiters: Array<(ok: boolean) => void>, ok: boolean): void {
  for (const w of waiters.splice(0)) w(ok);
}

/** Ask the computer how the lock stands for this browser. */
export async function refreshLock(): Promise<RemoteLockState | null> {
  try {
    const r = await lockCall("GET");
    if (r.status !== 200) return view.state;
    const state = r.body as unknown as RemoteLockState;
    set({ state, screen: state.locked });
    if (!state.locked) settle(unlockWaiters, true);
    return state;
  } catch {
    return view.state;
  }
}

export type UnlockAnswer = { ok: true } | { ok: false; error: string; retryAfterMs?: number; remaining?: number; removed?: boolean };

/** The owner's PIN. Right: the lock screen and the sheet close and every waiting request goes again. */
export async function unlockWith(pin: string): Promise<UnlockAnswer> {
  let r: { status: number; body: Record<string, unknown> };
  try {
    r = await lockCall("POST", "/unlock", { pin });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (r.status === 200) {
    set({ state: r.body as unknown as RemoteLockState, screen: false, prompt: false });
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
}

/** The owner closed the PIN sheet: the action that asked for it is not done. */
export function cancelPrompt(): void {
  set({ prompt: false });
  settle(promptWaiters, false);
}

/** Lock this browser now. */
export async function lockNow(): Promise<void> {
  await lockCall("POST", "/lock").catch(() => undefined);
  await refreshLock();
}

function wait(waiters: Array<(ok: boolean) => void>, signal: AbortSignal | null | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const done = (ok: boolean) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => {
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      reject(new DOMException("The request was aborted.", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.push(done);
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Whether the request can go again as it is: a Request object's body was read the first time. */
function replayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (typeof input === "string" || input instanceof URL) return true;
  return (init?.method ?? input.method).toUpperCase() === "GET";
}

async function lockCode(res: Response): Promise<RemoteLockCode | null> {
  if (res.status !== 423) return null;
  try {
    const code = ((await res.clone().json()) as { code?: unknown }).code;
    return code === "locked" || code === "pin-required" ? code : null;
  } catch {
    return null;
  }
}

/**
 * Wrap the page's fetch so a request the computer locked waits for the PIN
 * and goes again, and report the owner's touches so an unlocked browser stays
 * open. For a paired browser's page only.
 */
export function installLockGuard(win: Window & typeof globalThis = window): void {
  if (installed) return;
  installed = true;
  const original = win.fetch.bind(win);
  raw = original;
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original(input, init);
    const code = await lockCode(res);
    if (!code || urlOf(input).includes(LOCK_URL) || !replayable(input, init)) return res;
    let ok: boolean;
    if (code === "locked") {
      set({ screen: true, prompt: false });
      void refreshLock();
      ok = await wait(unlockWaiters, init?.signal);
    } else {
      set({ prompt: true });
      ok = await wait(promptWaiters, init?.signal);
    }
    return ok ? guarded(input, init) : res;
  };
  win.fetch = guarded as typeof fetch;

  let lastTouch = 0;
  const touched = () => {
    const s = view.state;
    if (!s?.whole || s.locked || view.screen) return;
    const now = Date.now();
    if (now - lastTouch < TOUCH_EVERY_MS) return;
    lastTouch = now;
    void lockCall("POST", "/touch").then((r) => {
      if (r.status === 200) {
        const state = r.body as unknown as RemoteLockState;
        set({ state, screen: state.locked });
      }
    }, () => undefined);
  };
  win.addEventListener("pointerdown", touched, { passive: true });
  win.addEventListener("keydown", touched);
  // Back after a while away: the computer may have locked it meanwhile.
  win.document.addEventListener("visibilitychange", () => {
    if (win.document.visibilityState === "visible") void refreshLock();
  });
}

/** For tests: forget the guard and the state. */
export function resetLockForTests(): void {
  installed = false;
  raw = (...a) => fetch(...a);
  view = { state: null, screen: false, prompt: false, removed: false };
  unlockWaiters = [];
  promptWaiters = [];
  listeners.clear();
}
