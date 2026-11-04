/**
 * Editor dialogs as the chat shows them: the daemon's state, kept current
 * from studio.dialog.changed. What the card says about them is in client-core.
 */
import { useEffect, useState } from "react";
import type { DialogsState } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../nav";
import type { DaemonState } from "./hooks";

/** The daemon's open dialogs, with the clock offset to its own; ticks while one is open. */
export function useDialogs(daemon: DaemonState): { state: DialogsState | null; now: () => number } {
  const { api } = useProjectNav();
  const [state, setState] = useState<{ s: DialogsState | null; offset: number }>({ s: null, offset: 0 });
  const [, tick] = useState(0);
  const take = (s: DialogsState) => setState({ s, offset: (s.now ?? Date.now()) - Date.now() });

  useEffect(() => {
    if (!daemon.streaming) return;
    // An older Studio agent has no route; nothing shows then.
    api.dialogs().then(take, () => {});
  }, [daemon.streaming, api]);

  const last = [...daemon.events].reverse().find((e) => e.type === "studio.dialog.changed");
  useEffect(() => {
    if (last) take(last.data as unknown as DialogsState);
  }, [last?.id]);

  const open = (state.s?.dialogs.length ?? 0) > 0;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [open]);

  return { state: state.s, now: () => Date.now() + state.offset };
}
