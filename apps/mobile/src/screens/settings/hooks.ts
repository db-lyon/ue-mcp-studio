/**
 * What the Settings, Plugins, Diagnostics and Feedback screens share: the
 * project's settings routes, and its live events.
 */
import { useEffect, useMemo, useRef } from "react";
import { settingsApi, type SettingsApi, type StreamEvent } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../nav";

export function useSettingsApi(): SettingsApi {
  const { project } = useProjectNav();
  return useMemo(() => settingsApi(project.transport), [project.transport]);
}

/** Calls `on` for every daemon event while the screen is open. */
export function useProjectEvents(on: (e: StreamEvent) => void): void {
  const { project } = useProjectNav();
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => project.onEvent((e) => latest.current(e)), [project]);
}
