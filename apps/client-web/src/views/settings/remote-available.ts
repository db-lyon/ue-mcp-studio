import { useCallback, useEffect, useRef, useState } from "react";
import { STUDIO_PLAN_AVAILABLE, remoteSurface, type RemoteSurface } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";

/** Whether this account may use remote control (a paid plan), asked of the agent. */
export async function remoteAvailable(refresh: boolean): Promise<boolean> {
  try {
    return (await api.remoteAvailable(refresh)).available === true;
  } catch (e) {
    // A paired browser is refused remote control's routes; the section says why itself.
    return e instanceof ApiError && e.status === 403;
  }
}

/**
 * What remote control shows this account (remoteSurface): the working section
 * on a paid plan, the plan note to a free account while STUDIO_PLAN_AVAILABLE
 * is on, nothing otherwise. An error reads as a free account, silently.
 * `refresh` asks the gateway past the agent's cache, as Settings does on open.
 */
export function useRemoteAvailable(refresh = true): { available: boolean | null; surface: RemoteSurface; recheck: () => void } {
  const [available, setAvailable] = useState<boolean | null>(null);
  const alive = useRef(true);
  const recheck = useCallback(() => {
    void remoteAvailable(true).then((a) => alive.current && setAvailable(a));
  }, []);
  useEffect(() => {
    alive.current = true;
    void remoteAvailable(refresh).then((a) => alive.current && setAvailable(a));
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  return { available, surface: remoteSurface(STUDIO_PLAN_AVAILABLE, available), recheck };
}
