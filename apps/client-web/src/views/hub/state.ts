/**
 * The hub's state on the page: whether the experiment is on, the overview
 * read from GET /v1/hub and read again on hub.changed, and the context every
 * hub screen draws from.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { StudioExperiments } from "@ue-mcp-studio/shared";
import type { HubOverview, QueueRequest } from "ue-mcp/daemon";
import { HUB_RELOAD_MS, hubReloadsOn, type HubRoute } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import type { DaemonState } from "../../state";

/** Fired on window when Settings changes an experiment, so the tabs follow without a reload. */
export const EXPERIMENTS_EVENT = "studio:experiments";

export function announceExperiments(e: StudioExperiments | undefined): void {
  if (typeof window === "undefined" || !e) return;
  window.dispatchEvent(new CustomEvent<StudioExperiments>(EXPERIMENTS_EVENT, { detail: e }));
}

/** The experiments as the agent has them; null until the first answer, which counts as off. */
export function useExperiments(events: DaemonState["events"]): StudioExperiments | null {
  const [x, setX] = useState<StudioExperiments | null>(null);
  const read = () => {
    api.settings().then((s) => setX({ playtestHub: s?.experiments?.playtestHub === true }), () => setX((cur) => cur ?? { playtestHub: false }));
  };
  useEffect(() => {
    read();
    const on = (e: Event) => setX({ playtestHub: (e as CustomEvent<StudioExperiments>).detail?.playtestHub === true });
    window.addEventListener(EXPERIMENTS_EVENT, on);
    return () => window.removeEventListener(EXPERIMENTS_EVENT, on);
  }, []);
  // Another window or the phone switched it: the agent says settings changed.
  const last = [...events].reverse().find((e) => e.type === "settings.changed" || e.type === "studio.settings.changed");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (last) read();
  }, [last?.id]);
  return x;
}

export interface HubData {
  overview: HubOverview | null;
  error: string | null;
  /** Bumped on every read, so a screen with its own detail reads it again too. */
  version: number;
  reload: () => void;
}

/** The overview while the hub is on: read when the stream is up, then again after hub events, a burst folded into one read. */
export function useHubOverview(daemon: Pick<DaemonState, "events" | "streaming">, on: boolean): HubData {
  const [overview, setOverview] = useState<HubOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const reload = () => {
    if (!on) return;
    api.hub.overview().then((o) => {
      if (!live.current) return;
      setOverview(o);
      setError(null);
      setVersion((v) => v + 1);
    }, (e: Error) => live.current && setError(e.message));
  };
  useEffect(() => {
    if (on) reload();
    else setOverview(null);
  }, [on, daemon.streaming]);
  const last = [...daemon.events].reverse().find((e) => hubReloadsOn(e.type));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef<number | undefined>(last?.id);
  useEffect(() => {
    if (!on || !last || last.id === seen.current) return;
    seen.current = last.id;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reload();
    }, HUB_RELOAD_MS);
  }, [last?.id, on]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return { overview, error, version, reload };
}

export interface HubContextValue {
  o: HubOverview;
  data: HubData;
  route: HubRoute;
  go: (r: HubRoute) => void;
  narrow: boolean;
  /** A short line at the foot of the hub: what just happened, or why it did not. */
  notify: (text: string, tone?: "ok" | "bad") => void;
  /** Queue a test or a suite and say where it went. */
  run: (req: QueueRequest, what: string) => Promise<void>;
}

export const HubContext = createContext<HubContextValue | null>(null);

export function useHub(): HubContextValue {
  const c = useContext(HubContext);
  if (!c) throw new Error("useHub outside the hub");
  return c;
}
