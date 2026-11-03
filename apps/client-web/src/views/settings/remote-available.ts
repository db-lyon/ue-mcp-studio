import { useCallback, useEffect, useRef, useState } from "react";
import { STUDIO_PLAN_AVAILABLE } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";

/** Whether remote control is offered, asked of the agent: null until it answers. */
export async function remoteAvailable(refresh: boolean): Promise<boolean> {
  if (STUDIO_PLAN_AVAILABLE) return true;
  try {
    return (await api.remoteAvailable(refresh)).available === true;
  } catch (e) {
    // A paired browser is refused remote control's routes; the section says why itself.
    return e instanceof ApiError && e.status === 403;
  }
}

/**
 * Remote control's place in Settings: on with STUDIO_PLAN_AVAILABLE, otherwise
 * while the agent says the account's plan covers it, asked fresh each time
 * Settings opens. Anything else, an error included, leaves it out silently.
 */
export function useRemoteAvailable(): { available: boolean | null; recheck: () => void } {
  const [available, setAvailable] = useState<boolean | null>(STUDIO_PLAN_AVAILABLE ? true : null);
  const alive = useRef(true);
  const recheck = useCallback(() => {
    void remoteAvailable(true).then((a) => alive.current && setAvailable(a));
  }, []);
  useEffect(() => {
    alive.current = true;
    recheck();
    return () => {
      alive.current = false;
    };
  }, [recheck]);
  return { available, recheck };
}
