/**
 * The web client's views/settings/remote-available.ts: whether this account
 * may use remote control (a paid plan) and whether any account is signed in,
 * asked of the agent, and the checkout watch after Upgrade.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { HttpError, type StudioApi } from "@ue-mcp-studio/client-core";
import { STUDIO_PLAN_AVAILABLE, remoteSurface, type RemoteSurface } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../../../nav";

export interface RemoteAnswer {
  /** A paid plan: remote control works. */
  available: boolean;
  /** A ue-mcp account is signed in on this computer. */
  signedIn: boolean;
}

export async function remoteAvailable(api: StudioApi, refresh: boolean): Promise<RemoteAnswer> {
  try {
    const a = await api.remoteAvailable(refresh);
    return { available: a.available === true, signedIn: a.signedIn !== false };
  } catch (e) {
    // A paired browser is refused remote control's routes; the section says why itself.
    return { available: e instanceof HttpError && e.status === 403, signedIn: true };
  }
}

/** Events after which the answer may have changed: the plan, or a sign-in or sign-out. */
const ACCOUNT_EVENTS = new Set(["studio.remote.available", "studio.settings.changed"]);

/** How often, and for how long, the plan is asked after a checkout opens. */
export const CHECKOUT_POLL_MS = 3000;
export const CHECKOUT_WATCH_MS = 15 * 60_000;

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
 * A checkout is open in the browser: ask every few seconds until the plan
 * shows, for up to CHECKOUT_WATCH_MS. It outlives the view that started it,
 * so dismissing the reply does not lose the pickup.
 */
export function watchForCheckout(api: StudioApi): void {
  stopCheckoutWatch();
  const until = Date.now() + CHECKOUT_WATCH_MS;
  const timer = setInterval(() => {
    if (Date.now() > until) return stopCheckoutWatch();
    void remoteAvailable(api, true).then((a) => {
      if (checkoutWatch?.timer !== timer) return;
      shareAnswer(a);
      if (a.available) stopCheckoutWatch();
    });
  }, CHECKOUT_POLL_MS);
  checkoutWatch = { timer, until };
}

/**
 * What remote control shows this account (remoteSurface). A sign-in or
 * sign-out anywhere asks again, and so does the app coming back to the
 * foreground after a checkout in the browser.
 */
export function useRemoteAvailable(refresh = true): { available: boolean | null; signedIn: boolean | null; surface: RemoteSurface; recheck: () => void } {
  const { api, project } = useProjectNav();
  const [answer, setAnswer] = useState<RemoteAnswer | null>(null);
  const alive = useRef(true);
  const recheck = useCallback(() => {
    void remoteAvailable(api, true).then((a) => alive.current && setAnswer(a));
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void remoteAvailable(api, refresh).then((a) => alive.current && setAnswer(a));
    const off = project.onEvent((e) => {
      if (ACCOUNT_EVENTS.has(e.type)) recheck();
    });
    const app = AppState.addEventListener?.("change", (s) => s === "active" && recheck());
    const onShared = (a: RemoteAnswer) => alive.current && setAnswer(a);
    answerListeners.add(onShared);
    return () => {
      alive.current = false;
      off();
      app?.remove();
      answerListeners.delete(onShared);
    };
  }, [api, project, refresh, recheck]);
  return {
    available: answer?.available ?? null,
    signedIn: answer?.signedIn ?? null,
    surface: remoteSurface(STUDIO_PLAN_AVAILABLE, answer?.available ?? null, answer?.signedIn ?? true),
    recheck,
  };
}
