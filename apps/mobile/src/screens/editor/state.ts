/**
 * The editor's state for a project's screens: the daemon's busy state, kept
 * current from studio.busy.changed with the offset to the daemon's clock, and
 * its health (which editors are connected), read again on editor and daemon
 * events.
 */
import { useCallback, useEffect, useState } from "react";
import { NO_BUSY, busyView, healthEditors, type BusyView, type HealthEditor } from "@ue-mcp-studio/client-core";
import type { BusyState } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../nav";

/** Health is read again on these events, as the web client's daemon state does. */
const HEALTH_ON = /^(editor|client|daemon)\./;

export function useBusy(): { busy: BusyView; now: () => number } {
  const { api, project } = useProjectNav();
  const [busy, setBusy] = useState<BusyView>(NO_BUSY);
  const [, tick] = useState(0);
  const streaming = project.live === "live";

  useEffect(() => {
    if (!streaming) return;
    let live = true;
    api.busy().then((s) => live && setBusy(busyView(s)), () => undefined);
    return () => void (live = false);
  }, [api, streaming]);

  useEffect(() => project.onEvent((e) => e.type === "studio.busy.changed" && setBusy(busyView(e.data as unknown as BusyState))), [project]);

  const running = busy.calls.length > 0 || !!busy.operation;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);

  return { busy, now: () => Date.now() + busy.offset };
}

export interface DaemonHealth {
  raw: Record<string, unknown> | null;
  editors: HealthEditor[];
  error: string | null;
}

export function useHealth(): DaemonHealth & { reload: () => void } {
  const { api, project } = useProjectNav();
  const [state, setState] = useState<DaemonHealth>({ raw: null, editors: [], error: null });
  const streaming = project.live === "live";
  const reload = useCallback(() => {
    api.daemonHealth().then(
      (h) => setState({ raw: h, editors: healthEditors(h), error: null }),
      (e: Error) => setState((s) => ({ ...s, error: e.message })),
    );
  }, [api]);
  useEffect(() => {
    if (streaming) reload();
  }, [streaming, reload]);
  useEffect(() => project.onEvent((e) => void (HEALTH_ON.test(e.type) && reload())), [project, reload]);
  return { ...state, reload };
}
