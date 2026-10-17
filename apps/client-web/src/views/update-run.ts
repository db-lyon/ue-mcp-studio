/**
 * One Update, as steps that survive the page going away. Updating Studio or
 * restarting ue-mcp reloads the panel, and updating the editor plugin closes
 * the editor the panel lives in, so the run is kept by Studio's agent (the
 * next page is served on another port, so the browser's storage is not
 * shared): the page that loads next settles the step that was running against
 * what the updates now say, then runs the rest.
 */
import { daemonMoves, pluginStep, readUpdates, type StudioUpdates, type UeMcpUpdate } from "./Updates";

export type StepKey = "ueMcp" | "plugin" | "studio" | "restart";
/** deferred: the agent keeps the step until no turn is in progress, then runs it. */
export type StepState = "pending" | "active" | "done" | "failed" | "deferred";
export interface RunStep {
  key: StepKey;
  state: StepState;
}
export interface UpdateRun {
  steps: RunStep[];
  /** The bridge plugin version the run installs, when it installs one. */
  target: string | null;
  at: number;
  /** The latest progress line from the step running. */
  detail?: string;
  error?: string;
  /** Every step done: what is installed now. */
  summary?: string;
}

type Updates = { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null };

/** A run older than this is from an update that never came back; it is dropped rather than resumed. */
const STALE_MS = 30 * 60_000;

export const STEP_NAME: Record<StepKey, string> = { ueMcp: "Bridge plugin", plugin: "Editor plugin", studio: "Studio", restart: "Restart ue-mcp" };
export const STEP_NOTE: Partial<Record<StepKey, string>> = {
  plugin: "The editor closes and reopens. Studio comes back with it.",
  studio: "ue-mcp restarts. This panel reloads when it is back.",
  restart: "ue-mcp restarts. This panel reloads when it is back.",
};

const RUN_URL = "/v1/ext/studio/updates/run";
let saving: Promise<unknown> = Promise.resolve();

/** Keep the run, in order: each write waits for the one before it. */
export function saveRun(run: UpdateRun | null): Promise<void> {
  saving = saving.then(() =>
    fetch(RUN_URL, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ run }) }).catch(() => {}));
  return saving.then(() => {});
}

export async function loadRun(now = Date.now()): Promise<UpdateRun | null> {
  const res = await fetch(RUN_URL, { credentials: "same-origin" }).catch(() => null);
  const run = res?.ok ? ((await res.json()) as { run: UpdateRun | null }).run : null;
  // A run waiting for a turn to finish is not stale however long the turn takes.
  return run && (now - run.at < STALE_MS || waitingSteps(run).length > 0) ? run : null;
}

/** The steps the agent keeps until no turn is in progress. */
export const waitingSteps = (run: UpdateRun): StepKey[] => run.steps.filter((s) => s.state === "deferred").map((s) => s.key);

/** The steps that restart the daemon or close the editor: they wait for the turns. */
const WAITS: StepKey[] = ["plugin", "studio", "restart"];

/** The steps one Update runs: the bridge plugin, the editor plugin, then Studio, which restarts ue-mcp; else a restart onto the new ue-mcp when the daemon runs another version. */
export function planRun(u: Updates, now = Date.now()): UpdateRun | null {
  const keys: StepKey[] = [];
  if (u.ueMcp?.target) keys.push("ueMcp");
  if (pluginStep(u.studio)) keys.push("plugin");
  if (u.studio?.studio.available) keys.push("studio");
  else if (keys.includes("ueMcp") && daemonMoves(u.ueMcp)) keys.push("restart");
  return keys.length ? { steps: keys.map((key) => ({ key, state: "pending" })), target: u.ueMcp?.target ?? null, at: now } : null;
}

/**
 * After the page came back: the step that was running is done when the
 * updates no longer offer it. An interrupted ue-mcp install runs again.
 */
export function settle(run: UpdateRun, u: Updates): UpdateRun {
  // A check that failed offers nothing, which says nothing about whether the step landed.
  const read = u.studio && !u.studio.error ? u.studio : null;
  const steps = run.steps.map((s): RunStep => {
    if (s.state !== "active") return s;
    switch (s.key) {
      case "ueMcp":
        return { ...s, state: "pending" };
      case "plugin":
        return { ...s, state: read && !pluginStep(read) ? "done" : "failed" };
      case "studio":
        return { ...s, state: read && !read.studio.available ? "done" : "failed" };
      case "restart":
        return { ...s, state: !run.target || u.ueMcp?.server === run.target ? "done" : "failed" };
    }
  });
  // A Studio that reads the plugin's own channel can find a plugin update the run did not plan.
  if (!steps.some((s) => s.key === "plugin") && pluginStep(read)) steps.push({ key: "plugin", state: "pending" });
  const failed = steps.find((s) => s.state === "failed");
  return { ...run, steps, detail: undefined, error: failed ? unfinished(failed.key, u) : run.error };
}

/**
 * The updates once the agent is running no step: a page that loads while the
 * plugin swaps (the editor closed under it, or a second window) waits for it.
 */
export async function afterRunning(read: () => Promise<Updates> = readUpdates, pollMs = 3000, limitMs = 15 * 60_000): Promise<Updates> {
  const until = Date.now() + limitMs;
  for (;;) {
    const u = await read();
    if (!u.studio?.running || Date.now() > until) return u;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Why a step that was running did not land, with the versions that say so. */
function unfinished(key: StepKey, u: Updates): string {
  const still = (name: string, installed: string | null | undefined, latest: string | null | undefined) =>
    installed && latest ? `${name} is still ${installed}; ${latest} did not install. Update tries again.` : `${name} did not finish. Update tries again.`;
  if (key === "plugin") return still("The editor plugin", u.studio?.plugin.installed, u.studio?.plugin.latest);
  if (key === "studio") return still("Studio", u.studio?.studio.installed, u.studio?.studio.latest);
  if (key === "restart") return still("ue-mcp", u.ueMcp?.server, u.ueMcp?.target);
  return `${STEP_NAME[key]} did not finish. Update tries again.`;
}

/** Restart now: the agent ends the turns in progress and runs the waiting steps. */
export async function restartNow(run: UpdateRun, onChange: (run: UpdateRun) => void, send = post): Promise<void> {
  const first = waitingSteps(run)[0];
  const next = { ...run, steps: run.steps.map((s) => (s.key === first ? { ...s, state: "active" as const } : s)) };
  onChange(next);
  await saveRun(next);
  const r = await send("/v1/ext/studio/updates/deferred/now");
  if (!r.ok) {
    const failed = { ...next, steps: next.steps.map((s) => (s.key === first ? { ...s, state: "failed" as const } : s)), error: r.error ?? "The update did not start." };
    onChange(failed);
    await saveRun(null);
  }
}

/** "Studio 0.1.0-beta.24, editor plugin 0.1.0-beta.11, bridge plugin 1.4.0-beta.4, ue-mcp 1.4.0-beta.4." */
export function summaryOf(u: Updates): string {
  const parts = [
    u.studio ? `Studio ${u.studio.studio.installed}` : "",
    u.studio?.plugin.installed ? `editor plugin ${u.studio.plugin.installed}` : "",
    u.ueMcp?.installed.version ? `bridge plugin ${u.ueMcp.installed.version}` : "",
    u.ueMcp ? `ue-mcp ${u.ueMcp.server}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "";
}

async function post(url: string, body?: unknown): Promise<{ ok: boolean; error?: string; deferred?: StepKey[] }> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e: Error) => ({ ok: false, json: async () => ({ error: e.message }) }) as Response);
  const j = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean; deferred?: StepKey[] };
  return { ok: res.ok && j.ok !== false, error: j.error, ...(Array.isArray(j.deferred) ? { deferred: j.deferred } : {}) };
}

/**
 * Run the pending steps in order, reporting each change. A step that takes
 * the daemon down ends this page's part: the page that loads next resumes.
 */
export async function execute(start: UpdateRun, onChange: (run: UpdateRun) => void, send: (url: string, body?: unknown) => Promise<{ ok: boolean; error?: string; deferred?: StepKey[] }> = post): Promise<void> {
  let run = start;
  const set = (next: UpdateRun) => {
    run = next;
    void saveRun(run);
    onChange(run);
  };
  const mark = (key: StepKey, state: StepState, extra: Partial<UpdateRun> = {}) =>
    set({ ...run, ...extra, steps: run.steps.map((s) => (s.key === key ? { ...s, state } : s)) });

  if (waitingSteps(run).length > 0) return onChange(run);
  for (const step of start.steps) {
    if (step.state !== "pending") continue;
    mark(step.key, "active", { detail: undefined });
    // The next page reads this, so it must be kept before ue-mcp or the editor goes away.
    await saving;
    const then = run.steps.filter((s) => s.state === "pending" && WAITS.includes(s.key)).map((s) => s.key);
    let r = step.key === "ueMcp"
      ? await send("/v1/update/apply", { version: run.target })
      : await send(`/v1/ext/studio/updates/${step.key}`, { then });
    // A bridge installed from source updates through the new package itself, then a rebuild.
    if (step.key === "ueMcp" && !r.ok && /source install/i.test(r.error ?? "")) r = await send("/v1/ext/studio/updates/ueMcp", { version: run.target });
    // A turn is in progress: the agent runs this and the rest once it finishes.
    if (r.ok && r.deferred) {
      set({ ...run, detail: undefined, steps: run.steps.map((s) => (r.deferred!.includes(s.key) && s.state !== "done" ? { ...s, state: "deferred" } : s)) });
      return;
    }
    if (!r.ok) {
      mark(step.key, "failed", { error: r.error ?? `${STEP_NAME[step.key]} failed.` });
      await saveRun(null);
      return;
    }
    // ue-mcp goes away now; this page reloads or closes with it.
    if (step.key === "studio" || step.key === "restart") return;
    mark(step.key, "done");
  }
  const after = await readUpdates().catch(() => null);
  await saveRun(null);
  onChange({ ...run, detail: undefined, summary: after ? summaryOf(after) : "" });
}
