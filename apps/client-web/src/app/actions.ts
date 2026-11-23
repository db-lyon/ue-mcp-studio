/**
 * What a project's buttons do, shared by its row on the list and its detail:
 * Add or Open Studio, Launch editor, Start and Stop its daemon, and Update.
 * Work in progress is kept by project key outside either view, so an install
 * started on the list is still shown on the project's detail, and back.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { StatusReport } from "ue-mcp/daemon";
import { beforeLaunch, consentAskOf, readRebuild, type ConsentAsk, type ProblemCopy } from "@ue-mcp-studio/client-core";
import type { Machine } from "./App";
import { follow, host, type IdeInfo, type JobState } from "./native";
import { installedKey, updatesOf, type MachineProject } from "./model";

/** Where a project's Studio opens to run its update: Settings, General, the Updates card. */
export const UPDATES_LOCATION = "#/settings/general";

export type WorkKind = "install" | "launch" | "studio" | "start" | "stop" | "update" | "ide" | "projectfiles" | "rebuild";

/** Open in IDE found no solution for Visual Studio: what the page can offer instead. */
export interface NeedsFiles {
  /** The IDE that was asked for, opened once the files are generated. */
  ide: string;
  name: string;
  generate: boolean;
  source: boolean;
  /** VS Code is here, to open the folder instead. */
  code: boolean;
}

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
  needsFiles?: NeedsFiles;
  /** Launch editor found a problem that makes Unreal ask to rebuild on launch, and waits for Rebuild or Launch anyway. */
  beforeLaunch?: ProblemCopy;
  /** Rebuild is held by other sessions using the editor, and waits for Rebuild anyway or Cancel. */
  consent?: ConsentAsk;
}

/**
 * Each project's install report (ue-mcp status), by key. ue-mcp reads it from
 * the project's files, so it names problems the editor never gets far enough
 * to report, such as a bridge built for another engine build.
 */
let reports: Record<string, StatusReport> = {};
const reportListeners = new Set<() => void>();
/** One read at a time: each is a ue-mcp process, and a long list would otherwise start them all at once. */
let reportQueue: Promise<unknown> = Promise.resolve();

/** Read a project's install report again; null when the host cannot (an older host, no Node.js, a failed read). */
export function loadReport(p: MachineProject): Promise<StatusReport | null> {
  const read = reportQueue.then(async () => {
    const h = host();
    if (!h?.status || !p.ueMcp.setUp) return null;
    const r = await h.status({ uproject: p.uproject }).catch(() => null);
    let parsed: StatusReport | null = null;
    try {
      parsed = r?.ok && r.report ? (JSON.parse(r.report) as StatusReport) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.problems)) return null;
    reports = { ...reports, [p.key]: parsed };
    reportListeners.forEach((l) => l());
    return parsed;
  });
  reportQueue = read.catch(() => null);
  return read;
}

/** A project's install report: the last read at once, read again when `when` changes. */
export function useInstallReport(p: MachineProject, when: unknown): StatusReport | null {
  const report = useSyncExternalStore(
    (l) => {
      reportListeners.add(l);
      return () => reportListeners.delete(l);
    },
    () => reports[p.key] ?? null,
  );
  useEffect(() => {
    if (p.ueMcp.setUp) void loadReport(p);
  }, [p.key, p.uproject, p.ueMcp.setUp, when]);
  return report;
}

/** Forget every project's install report, for tests. */
export function resetReports(): void {
  reports = {};
  reportQueue = Promise.resolve();
}

/** The IDEs and project files the host found, by project key, read again whenever a view asks. */
let ideInfos: Record<string, IdeInfo> = {};
const ideListeners = new Set<() => void>();

/** Read a project's IDEs again. */
export async function loadIdes(p: MachineProject): Promise<IdeInfo | null> {
  const info = await host()?.ides({ key: p.key, uproject: p.uproject });
  if (!info) return null;
  ideInfos = { ...ideInfos, [p.key]: info };
  ideListeners.forEach((l) => l());
  return info;
}

/** A project's IDEs: the last read at once, read again when `active` turns on. */
export function useIdes(p: MachineProject, active: boolean): IdeInfo | null {
  const info = useSyncExternalStore(
    (l) => {
      ideListeners.add(l);
      return () => ideListeners.delete(l);
    },
    () => ideInfos[p.key] ?? null,
  );
  useEffect(() => {
    if (active) void loadIdes(p);
  }, [active, p.key, p.uproject]);
  return info;
}

/** Forget every project's IDEs, for tests. */
export function resetIdes(): void {
  ideInfos = {};
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
    /**
     * Launch editor. A project ue-mcp is set up in has its install report read
     * first: when it names a problem that makes Unreal ask to rebuild modules on
     * launch, the launch waits and Rebuild is offered instead (`anyway` skips it).
     */
    launch: async (anyway = false) => {
      set({ kind: "launch" });
      if (!anyway && p.ueMcp.setUp) {
        const problem = beforeLaunch(await loadReport(p));
        if (problem) return set({ kind: "launch", beforeLaunch: problem });
      }
      const r = await host()?.launcheditor({ key: p.key, uproject: p.uproject, setUp: p.ueMcp.setUp });
      set(r?.ok ? null : { kind: "launch", error: r?.error ?? "The editor did not start." });
      void m.refresh();
    },
    /**
     * The daemon's rebuild: build the project's C++ for this engine, then open
     * the editor. While other sessions use the editor the daemon holds it (409
     * with its consent request): the person sees who and why, and `force`
     * rebuilds anyway.
     */
    rebuild: async (force = false) => {
      set({ kind: "rebuild" });
      const r = await host()?.rebuild?.({ key: p.key, uproject: p.uproject, ...(force ? { force: "yes" as const } : {}) });
      let failed = r ? r.error ?? null : "This version of the UE-MCP Launcher cannot rebuild projects. Update it in Settings.";
      if (r?.body) {
        let steps: Record<string, unknown> | null = null;
        try {
          steps = JSON.parse(r.body) as Record<string, unknown>;
        } catch {
          steps = null;
        }
        const held = consentAskOf("rebuild", { status: r.status, body: steps });
        if (held) return set({ kind: "rebuild", consent: held });
        const outcome = steps ? readRebuild(steps) : null;
        if (outcome && !outcome.ok) {
          failed = outcome.built && outcome.failure?.step === "start"
            ? `The bridge plugin was rebuilt, but the editor did not open. ${outcome.failure.reason}`
            : `The rebuild did not finish. ${outcome.failure?.reason ?? ""}`.trim();
        }
      }
      set(failed ? { kind: "rebuild", error: failed } : null);
      void loadReport(p);
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
    /** Cancel a held rebuild: its request is denied, so the sessions it was put to stop waiting on it. */
    cancelConsent: () => {
      const id = current?.consent?.request.id;
      if (id) void host()?.denyconsent?.({ key: p.key, id }).catch(() => undefined);
      set(null);
    },
    /**
     * Open in IDE, or with one IDE from Open with... (kept for the project
     * unless `remember` is false). Visual Studio without a solution asks to
     * generate the project files, or to open the folder in VS Code.
     */
    openIde: async (ide?: string, remember = true) => {
      set({ kind: "ide" });
      const r = await host()?.openide({ key: p.key, uproject: p.uproject, ...(ide ? { ide, ...(remember ? { remember: "yes" as const } : {}) } : {}) });
      if (ide && remember) void loadIdes(p);
      if (r?.ok) return set(null);
      if (r?.needsProjectFiles && r.ide) {
        const info = await loadIdes(p);
        return set({ kind: "ide", needsFiles: { ide: r.ide, name: r.name ?? "Visual Studio", generate: !!info?.generate, source: !!info?.source, code: !!info?.ides?.some((x) => x.kind === "vscode") } });
      }
      set({ kind: "ide", error: r?.error ?? "The IDE did not open." });
    },
    /** Generate the project files, then open the IDE that needed them. */
    generateFiles: async (then?: string) => {
      const end = await runJob("projectfiles", host()?.projectfiles({ uproject: p.uproject }), "The project files were not generated.");
      void loadIdes(p);
      if (!end?.ok || !then) return;
      const r = await host()?.openide({ key: p.key, uproject: p.uproject, ide: then });
      if (!r?.ok) set({ kind: "ide", error: r?.error ?? "The IDE did not open." });
    },
    reveal: () => void host()?.reveal({ uproject: p.uproject }),
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
    projectfiles: [`Generating project files for ${name}`, "The project files are generated", "The project files were not generated"],
    launch: ["", "", ""],
    rebuild: ["", "", ""],
    studio: ["", "", ""],
    ide: ["", "", ""],
  };
  return t[kind][job.running ? 0 : job.ok ? 1 : 2];
}
