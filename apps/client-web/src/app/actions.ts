/**
 * What a project's buttons do, shared by its row on the list and its detail:
 * Add or Open Studio, Launch editor, Start and Stop its daemon, and Update.
 * Work in progress is kept by project key outside either view, so an install
 * started on the list is still shown on the project's detail, and back.
 */
import { useSyncExternalStore } from "react";
import type { Machine } from "./App";
import { follow, host, type JobState } from "./native";
import { installedKey, updatesOf, type MachineProject } from "./model";

/** Where a project's Studio opens to run its update: Settings, General, the Updates card. */
export const UPDATES_LOCATION = "#/settings/general";

export type WorkKind = "install" | "launch" | "studio" | "start" | "stop" | "update";

/** An action in progress or just ended, for one project. */
export interface Work {
  kind: WorkKind;
  job?: JobState;
  error?: string;
  done?: boolean;
  /** Stop waits for a second press while the daemon has an editor or a client connected. */
  confirm?: string;
  /** Update was handed to the project's Studio, and the list is read again until its versions change. */
  watching?: boolean;
}

/** After handing an update to Studio: how often the report is read again, and for how long at most. */
export const WATCH_UPDATE = { everyMs: 8_000, forMs: 5 * 60_000 };

let works: Record<string, Work> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setWork(key: string, w: Work | null): void {
  const next = { ...works };
  if (w) next[key] = w;
  else delete next[key];
  works = next;
  emit();
}

/** Forget every project's work, for tests. */
export function resetWork(): void {
  works = {};
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Every project's work, redrawn when any changes. */
export function useWorks(): Record<string, Work> {
  return useSyncExternalStore(subscribe, () => works);
}

/** Whether an action that runs a job is running anywhere: installs and updates run one at a time. */
export const installing = (all: Record<string, Work>): boolean => Object.values(all).some((w) => (w.kind === "install" || w.kind === "update") && !!w.job?.running);

interface Health {
  editors: Array<{ name: string; connected: boolean }>;
  clients: number;
}

/** "1 editor connected, 2 clients", or "" when nothing is connected or health did not answer. */
export async function connectedTo(key: string): Promise<string> {
  const r = await host()?.daemon({ key, method: "GET", path: "/v1/health" });
  try {
    const h = r?.status === 200 && r.body ? (JSON.parse(r.body) as Health) : null;
    if (!h) return "";
    const editors = h.editors.filter((e) => e.connected).length;
    if (!editors && !h.clients) return "";
    return [editors ? `${editors} editor${editors > 1 ? "s" : ""} connected` : "", h.clients ? `${h.clients} client${h.clients === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

/** The actions for one project. */
export function projectActions(p: MachineProject, m: Machine, current: Work | null) {
  const set = (w: Work | null) => setWork(p.key, w);
  const runJob = async (kind: WorkKind, start: Promise<{ ok: boolean; job?: number; error?: string }> | undefined, failed: string) => {
    set({ kind, job: { running: true, ok: false, lines: [] } });
    const started = await start;
    if (!started?.ok || !started.job) return set({ kind, error: started?.error ?? failed });
    const end = await follow(started.job, (job) => set({ kind, job }));
    set({ kind, job: end, done: true });
    void m.refresh();
    return end;
  };
  return {
    addStudio: () => runJob("install", host()?.install({ uproject: p.uproject }), "The install did not start."),
    openStudio: async (location?: string) => {
      set({ kind: "studio" });
      const r = await host()?.openstudio({ key: p.key, uproject: p.uproject, ...(location ? { location } : {}) });
      set(r?.ok ? null : { kind: "studio", error: r?.error ?? "Studio did not open." });
      void m.refresh();
    },
    launch: async () => {
      set({ kind: "launch" });
      const r = await host()?.launcheditor({ key: p.key, uproject: p.uproject, setUp: p.ueMcp.setUp });
      set(r?.ok ? null : { kind: "launch", error: r?.error ?? "The editor did not start." });
      void m.refresh();
    },
    start: async () => {
      const end = await runJob("start", host()?.startdaemon({ uproject: p.uproject }), "ue-mcp did not start.");
      if (end?.ok) set(null);
    },
    stop: async () => {
      if (!current?.confirm) {
        const use = await connectedTo(p.key);
        if (use) return set({ kind: "stop", confirm: use });
      }
      const end = await runJob("stop", host()?.stopdaemon({ uproject: p.uproject }), "The daemon did not stop.");
      if (end?.ok) set(null);
    },
    cancel: () => set(null),
    update: async () => {
      const u = updatesOf(p, m.newest);
      if (!u?.via) return;
      if (u.via === "studio") {
        set({ kind: "update" });
        const r = await host()?.openstudio({ key: p.key, uproject: p.uproject, location: UPDATES_LOCATION });
        if (!r?.ok) return set({ kind: "update", error: r?.error ?? "Studio did not open." });
        return watchUpdate(p, m);
      }
      const version = m.newest?.ueMcp;
      if (!version) return;
      await runJob("update", host()?.updatebridge({ uproject: p.uproject, version }), "The update did not start.");
    },
  };
}

/**
 * Studio runs the update in its own window, out of this app's sight, so the
 * list is read again every few seconds until the project's versions change
 * or WATCH_UPDATE.forMs passes. The host's file watching usually sees it
 * first; this is the fallback. Dismissing the note stops it.
 */
async function watchUpdate(p: MachineProject, m: Machine): Promise<void> {
  const before = installedKey(p);
  const mine = { kind: "update" as const, watching: true };
  setWork(p.key, mine);
  const until = Date.now() + WATCH_UPDATE.forMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, WATCH_UPDATE.everyMs));
    if (works[p.key] !== mine) return;
    const report = await m.refresh();
    if (works[p.key] !== mine) return;
    const now = report?.projects.find((x) => x.key === p.key);
    if (now && installedKey(now) !== before) return setWork(p.key, null);
  }
  if (works[p.key] === mine) setWork(p.key, null);
}

/** The job box's title for each action. */
export function workTitle(kind: WorkKind, job: JobState, name: string): string {
  const t: Record<WorkKind, [string, string, string]> = {
    install: [`Adding Studio to ${name}`, "Studio was added", "Studio was not added"],
    update: ["Updating the bridge plugin", "The bridge plugin is updated", "The bridge plugin was not updated"],
    start: [`Starting ue-mcp for ${name}`, "ue-mcp started", "ue-mcp did not start"],
    stop: [`Stopping ue-mcp for ${name}`, "ue-mcp stopped", "ue-mcp did not stop"],
    launch: ["", "", ""],
    studio: ["", "", ""],
  };
  return t[kind][job.running ? 0 : job.ok ? 1 : 2];
}
