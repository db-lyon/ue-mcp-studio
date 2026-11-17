import { useCallback, useRef, useState } from "react";

/**
 * A pending state for one slow action: `busy` is true from the press until the action settles, and `run` ignores a press made meanwhile,
 * so a second click cannot start the action twice. A rejection still clears `busy`, then reaches the caller.
 */
export function useBusy(): [boolean, <T>(fn: () => Promise<T> | T) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T> | T): Promise<T | undefined> => {
    if (live.current) return undefined;
    live.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      live.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
