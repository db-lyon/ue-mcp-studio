/**
 * Editor dialogs as the panel shows them: the daemon's state, kept current
 * from studio.dialog.changed. What the card says about them is in client-core.
 */
import { useEffect, useState } from "react";
import type { DialogsState } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../../nav";

/** The daemon's open dialogs, with the clock offset to its own; ticks while one is open. */
export function useDialogs(): { state: DialogsState | null; now: () => number } {
  const { project, api } = useProjectNav();
  const [state, setState] = useState<{ s: DialogsState | null; offset: number }>({ s: null, offset: 0 });
  const [, tick] = useState(0);
  const take = (s: DialogsState) => setState({ s, offset: s.now - Date.now() });

  useEffect(() => {
    if (project.live !== "live") return;
    // An older Studio agent has no route; nothing shows then.
    api.dialogs().then(take, () => {});
  }, [project.live, api]);

  useEffect(() => project.onEvent((e) => e.type === "studio.dialog.changed" && take(e.data as unknown as DialogsState)), [project]);

  const open = (state.s?.dialogs.length ?? 0) > 0;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [open]);

  return { state: state.s, now: () => Date.now() + state.offset };
}
