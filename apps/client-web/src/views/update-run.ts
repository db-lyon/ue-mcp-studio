/**
 * One Update, as steps that survive the page going away. Updating Studio or
 * restarting ue-mcp reloads the panel, and updating the editor plugin closes
 * the editor the panel lives in, so the run is kept by Studio's agent (the
 * next page is served on another port, so the browser's storage is not
 * shared): the page that loads next settles the step that was running against
 * what the updates now say, then runs the rest.
 */
import { readUpdates, type StudioUpdates, type UeMcpUpdate } from "./Updates";

export type StepKey = "ueMcp" | "plugin" | "studio" | "restart";
export type StepState = "pending" | "active" | "done" | "failed";
export interface RunStep {
  key: StepKey;
  state: StepState;
}
export interface UpdateRun {
  steps: RunStep[];
  /** The ue-mcp version the run installs, when it installs one. */
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

export const STEP_NAME: Record<StepKey, string> = { ueMcp: "ue-mcp", plugin: "Editor plugin", studio: "Studio", restart: "Restart ue-mcp" };
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
  return run && now - run.at < STALE_MS ? run : null;
}

/** The steps one Update runs: ue-mcp, the editor plugin, then Studio, which restarts ue-mcp; else a restart onto the new ue-mcp. */
export function planRun(u: Updates, now = Date.now()): UpdateRun | null {
  const keys: StepKey[] = [];
  if (u.ueMcp?.target) keys.push("ueMcp");
  if (u.studio?.plugin.available) keys.push("plugin");
  if (u.studio?.studio.available) keys.push("studio");
  else if (keys.includes("ueMcp")) keys.push("restart");
  return keys.length ? { steps: keys.map((key) => ({ key, state: "pending" })), target: u.ueMcp?.target ?? null, at: now } : null;
}

/**
 * After the page came back: the step that was running is done when the
 * updates no longer offer it. An interrupted ue-mcp install runs again.
 */
export function settle(run: UpdateRun, u: Updates): UpdateRun {
  const steps = run.steps.map((s): RunStep => {
    if (s.state !== "active") return s;
    switch (s.key) {
      case "ueMcp":
        return { ...s, state: "pending" };
      case "plugin":
        return { ...s, state: u.studio && !u.studio.plugin.available ? "done" : "failed" };
      case "studio":
        return { ...s, state: u.studio && !u.studio.studio.available ? "done" : "failed" };
      case "restart":
        return { ...s, state: !run.target || u.ueMcp?.server === run.target ? "done" : "failed" };
    }
  });
  // A Studio that reads the plugin's own channel can find a plugin update the run did not plan.
  if (!steps.some((s) => s.key === "plugin") && u.studio?.plugin.available) steps.push({ key: "plugin", state: "pending" });
  const failed = steps.find((s) => s.state === "failed");
  return { ...run, steps, detail: undefined, error: failed ? `${STEP_NAME[failed.key]} did not finish. Open Details in Updates to see what is installed.` : run.error };
}

/** "Studio 0.1.0-beta.24, editor plugin 0.1.0-beta.11, ue-mcp 1.4.0-beta.4." */
export function summaryOf(u: Updates): string {
  const parts = [
    u.studio ? `Studio ${u.studio.studio.installed}` : "",
    u.studio?.plugin.installed ? `editor plugin ${u.studio.plugin.installed}` : "",
    u.ueMcp ? `ue-mcp ${u.ueMcp.server}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "";
}

async function post(url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e: Error) => ({ ok: false, json: async () => ({ error: e.message }) }) as Response);
  const j = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
  return { ok: res.ok && j.ok !== false, error: j.error };
}

/**
 * Run the pending steps in order, reporting each change. A step that takes
 * the daemon down ends this page's part: the page that loads next resumes.
 */
export async function execute(start: UpdateRun, onChange: (run: UpdateRun) => void, send = post): Promise<void> {
  let run = start;
  const set = (next: UpdateRun) => {
    run = next;
    void saveRun(run);
    onChange(run);
  };
  const mark = (key: StepKey, state: StepState, extra: Partial<UpdateRun> = {}) =>
    set({ ...run, ...extra, steps: run.steps.map((s) => (s.key === key ? { ...s, state } : s)) });

  for (const step of start.steps) {
    if (step.state !== "pending") continue;
    mark(step.key, "active", { detail: undefined });
    // The next page reads this, so it must be kept before ue-mcp or the editor goes away.
    await saving;
    const r = step.key === "ueMcp"
      ? await send("/v1/update/apply", { version: run.target })
      : await send(`/v1/ext/studio/updates/${step.key}`);
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
