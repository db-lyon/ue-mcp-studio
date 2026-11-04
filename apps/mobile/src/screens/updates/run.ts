/**
 * The update the computer is running, as a paired client follows it: the
 * agent says when a step starts, waits for a turn and ends (studio.update.run),
 * and how the plugin step goes (studio.update.progress). A paired client never
 * starts or resumes one; it only shows what the computer does.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { StreamEvent, UpdateRun } from "@ue-mcp-studio/client-core";

let current: UpdateRun | null = null;
const listeners = new Set<() => void>();

export function setUpdateRun(run: UpdateRun | null): void {
  current = run;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The run being followed, if any. */
export const useUpdateRun = (): UpdateRun | null => useSyncExternalStore(subscribe, () => current, () => current);

/** Applies one daemon event to the run being followed. */
export function followUpdateEvent(e: StreamEvent): void {
  if (e.type === "studio.update.run") setUpdateRun((e.data.run as UpdateRun | null) ?? null);
  else if (current && e.type === "studio.update.progress" && typeof e.data.message === "string") setUpdateRun({ ...current, detail: e.data.message });
}

/** A finished run says what is installed for five seconds, then gets out of the way. */
export function useFinishedRunClears(run: UpdateRun | null): void {
  useEffect(() => {
    if (run?.summary === undefined) return;
    const t = setTimeout(() => setUpdateRun(null), 5000);
    return () => clearTimeout(t);
  }, [run?.summary]);
}
