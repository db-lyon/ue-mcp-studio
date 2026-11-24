/**
 * The hub's state on the page: whether the experiment is on, the overview
 * read from GET /hub and read again as runs, goals and the queue change, and
 * the context every hub screen draws from.
 */
import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import type { HubOverview, PlanRequest, StudioExperiments } from "@ue-mcp-studio/shared";
import { HUB_RELOAD_MS, hubReloadsOn, type HubKeyAction, type HubRoute } from "@ue-mcp-studio/client-core";
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
  /** Change the overview in place ahead of the daemon's answer; the next read replaces it. */
  patch: (f: (o: HubOverview) => HubOverview) => void;
}

/**
 * The overview, while the hub is on: read when the stream is up, then again
 * after hub.changed, studio.qa.changed and script.* events. A run's
 * burst of script events is folded into one read per HUB_RELOAD_MS.
 */
export function useHubOverview(daemon: Pick<DaemonState, "events" | "streaming">, on: boolean): HubData {
  const [overview, setOverview] = useState<HubOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const live = useRef(true);
  // Set on every mount: StrictMode mounts twice, and the first unmount must not silence the second.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const reload = () => {
    if (!on) return;
    setVersion((v) => v + 1);
    api.hub.overview().then((o) => {
      if (!live.current) return;
      setOverview(o);
      setError(null);
    }, (e: Error) => live.current && setError(e.message));
  };
  // Read when the hub is switched on, and again when the stream comes back, since events may have been missed.
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
  return { overview, error, version, reload, patch: (f) => setOverview((o) => (o ? f(o) : o)) };
}

/** What a new goal starts with: the goals it is part of, and its kind. */
export interface GoalPreset {
  parents?: string[];
  kind?: "goal" | "milestone";
}

export interface HubContextValue {
  o: HubOverview;
  data: HubData;
  route: HubRoute;
  go: (r: HubRoute) => void;
  narrow: boolean;
  /** A short line at the foot of the hub: what just happened, or why it did not. */
  notify: (text: string, tone?: "ok" | "bad") => void;
  /** Queue a plan and say what was queued. */
  runPlan: (req: PlanRequest, what?: string) => Promise<void>;
  runCheck: (checkId: string, name?: string) => Promise<void>;
  openChat: (sessionId: string, runId?: string) => void;
  editGoal: (goalId: string | null, preset?: GoalPreset) => void;
  addChecks: (goalId: string) => void;
  /** Pick an existing goal for this goal to require. */
  requireGoal: (goalId: string) => void;
  /** Ask which goal to add these checks to. */
  addToGoal: (checkIds: string[]) => void;
  /** The screen on show takes the keys the hub does not handle itself, set on each render; return true when one was used. */
  onKeys: (handler: (a: HubKeyAction) => boolean) => void;
}

export const HubContext = createContext<HubContextValue | null>(null);

export function useHub(): HubContextValue {
  const c = useContext(HubContext);
  if (!c) throw new Error("useHub outside the hub");
  return c;
}

/**
 * A cursor over a screen's rows for j and k: the index, kept inside the list,
 * and the row it lands on scrolled into view.
 */
export function useCursor(count: number, list: RefObject<HTMLElement>): [number, (i: number) => void, (d: number) => void] {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (at > 0 && at >= count) setAt(Math.max(0, count - 1));
  }, [count]);
  const set = (i: number) => {
    const next = Math.max(0, Math.min(count - 1, i));
    setAt(next);
    const row = list.current?.querySelectorAll<HTMLElement>("[data-row]")[next];
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  };
  return [Math.min(at, Math.max(0, count - 1)), set, (d) => set(at + d)];
}
