import { useCallback, useEffect, useRef, useState } from "react";
import { REMOTE_PLAN_OFFERED, remoteSurface, type RemoteSurface } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { subscribeEvent } from "../../extensions/events";

export interface RemoteAnswer {
  /** A paid plan: remote control works. */
  available: boolean;
  /** A ue-mcp account is signed in on this computer. */
  signedIn: boolean;
  /** This is a paired device: the computer refused the check, as it refuses a paired device every remote control route. */
  paired: boolean;
}

/** Whether this account may use remote control (a paid plan), and whether any account is signed in, asked of the agent. */
export async function remoteAvailable(refresh: boolean): Promise<RemoteAnswer> {
  try {
    const a = await api.remoteAvailable(refresh);
    return { available: a.available === true, signedIn: a.signedIn !== false, paired: false };
  } catch (e) {
    // A paired device is refused remote control's routes: listed as working, and answered with REMOTE_ON_COMPUTER.
    const paired = e instanceof ApiError && e.status === 403;
    return { available: paired, signedIn: true, paired };
  }
}

/** Events after which the answer may have changed: the plan, or a sign-in or sign-out. */
const ACCOUNT_EVENTS = new Set(["studio.remote.available", "studio.settings.changed"]);

/** How often, and for how long, the plan is asked after a checkout opens. */
export const CHECKOUT_POLL_MS = 3000;
export const CHECKOUT_WATCH_MS = 15 * 60_000;

/** Every mounted useRemoteAvailable, so one answer reaches them all at once. */
const answerListeners = new Set<(a: RemoteAnswer) => void>();
let checkoutWatch: { timer: ReturnType<typeof setInterval>; until: number } | null = null;

function shareAnswer(a: RemoteAnswer): void {
  for (const l of [...answerListeners]) l(a);
}

/** Stop asking after a checkout. */
export function stopCheckoutWatch(): void {
  if (checkoutWatch) clearInterval(checkoutWatch.timer);
  checkoutWatch = null;
}

/**
 * A checkout is open in the browser: ask the gateway every few seconds until
 * the plan shows, for up to CHECKOUT_WATCH_MS. It outlives the view that
 * started it, so dismissing the chat reply does not lose the pickup; a second
 * call restarts the window. The window's focus event is not relied on,
 * because the editor's host does not always send it.
 */
export function watchForCheckout(): void {
  stopCheckoutWatch();
  const until = Date.now() + CHECKOUT_WATCH_MS;
  const timer = setInterval(() => {
    if (Date.now() > until) return stopCheckoutWatch();
    void remoteAvailable(true).then((a) => {
      if (checkoutWatch?.timer !== timer) return;
      shareAnswer(a);
      if (a.available) stopCheckoutWatch();
    });
  }, CHECKOUT_POLL_MS);
  checkoutWatch = { timer, until };
}

/**
 * What remote control shows this account (remoteSurface): the working section
 * on a paid plan; while REMOTE_PLAN_OFFERED is on, a sign-in when no account
 * is signed in and the plan note to a free account; nothing otherwise. An
 * error reads as a free account, silently. `refresh` asks the gateway past the
 * agent's cache, as Settings does on open. A sign-in or sign-out anywhere in
 * Studio asks again, and so does Studio's window coming back into focus, after
 * a checkout in the browser, and every answer watchForCheckout gets.
 */
export function useRemoteAvailable(refresh = true): { available: boolean | null; signedIn: boolean | null; paired: boolean; surface: RemoteSurface; recheck: () => void } {
  const [answer, setAnswer] = useState<RemoteAnswer | null>(null);
  const alive = useRef(true);
  const recheck = useCallback(() => {
    void remoteAvailable(true).then((a) => alive.current && setAnswer(a));
  }, []);
  useEffect(() => {
    alive.current = true;
    void remoteAvailable(refresh).then((a) => alive.current && setAnswer(a));
    const unsubscribe = subscribeEvent((e) => {
      if (ACCOUNT_EVENTS.has(e.type)) recheck();
    });
    // Back from a checkout in the browser: ask the gateway at once rather than wait for the agent's recheck.
    const onFocus = () => recheck();
    const onVisible = () => document.visibilityState === "visible" && recheck();
    const onShared = (a: RemoteAnswer) => alive.current && setAnswer(a);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    answerListeners.add(onShared);
    return () => {
      alive.current = false;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      answerListeners.delete(onShared);
    };
  }, [refresh]);
  return {
    available: answer?.available ?? null,
    signedIn: answer?.signedIn ?? null,
    paired: answer?.paired ?? false,
    surface: remoteSurface(REMOTE_PLAN_OFFERED, answer?.available ?? null, answer?.signedIn ?? true),
    recheck,
  };
}
