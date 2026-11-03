import { useCallback, useEffect, useRef, useState } from "react";
import { STUDIO_PLAN_AVAILABLE, remoteSurface, type RemoteSurface } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { subscribeEvent } from "../../extensions/events";

export interface RemoteAnswer {
  /** A paid plan: remote control works. */
  available: boolean;
  /** A ue-mcp account is signed in on this computer. */
  signedIn: boolean;
}

/** Whether this account may use remote control (a paid plan), and whether any account is signed in, asked of the agent. */
export async function remoteAvailable(refresh: boolean): Promise<RemoteAnswer> {
  try {
    const a = await api.remoteAvailable(refresh);
    return { available: a.available === true, signedIn: a.signedIn !== false };
  } catch (e) {
    // A paired browser is refused remote control's routes; the section says why itself.
    return { available: e instanceof ApiError && e.status === 403, signedIn: true };
  }
}

/** Events after which the answer may have changed: the plan, or a sign-in or sign-out. */
const ACCOUNT_EVENTS = new Set(["studio.remote.available", "studio.settings.changed"]);

/**
 * What remote control shows this account (remoteSurface): the working section
 * on a paid plan; while STUDIO_PLAN_AVAILABLE is on, a sign-in when no account
 * is signed in and the plan note to a free account; nothing otherwise. An
 * error reads as a free account, silently. `refresh` asks the gateway past the
 * agent's cache, as Settings does on open. A sign-in or sign-out anywhere in
 * Studio asks again, and so does Studio's window coming back into focus, after
 * a checkout in the browser.
 */
export function useRemoteAvailable(refresh = true): { available: boolean | null; signedIn: boolean | null; surface: RemoteSurface; recheck: () => void } {
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
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return {
    available: answer?.available ?? null,
    signedIn: answer?.signedIn ?? null,
    surface: remoteSurface(STUDIO_PLAN_AVAILABLE, answer?.available ?? null, answer?.signedIn ?? true),
    recheck,
  };
}
