/**
 * /flow <name>: any of the project's flows, run through the daemon's
 * POST /v1/flows/<name>/run with the params the user gave. The daemon puts
 * the run's /v1/flows/events on its event stream as flow.*; the run's own are
 * those after the first flow.run_started of that flow, by its runId.
 */
import type { FlowStepProgress } from "@ue-mcp-studio/shared";
import type { DaemonEndpoint, FlowEventLike } from "./playtest-flow.js";

export interface FlowCallOptions {
  endpoint: () => DaemonEndpoint | null;
  subscribe: (listener: (e: FlowEventLike) => void) => () => void;
  fetchImpl?: typeof fetch;
}

/** How a run ended: whether it succeeded, its summary, and why it failed. */
export interface FlowCallOutcome {
  success: boolean;
  summary?: string;
  errors: string[];
  duration?: number;
  /** The steps the run's answer reports, for a card whose events were missed. */
  steps: FlowStepProgress[];
}

interface StepReport {
  stepNumber?: number;
  name?: string;
  success?: boolean;
  skipped?: boolean;
  error?: { message?: string };
}

/** A step event's step, as the card keys it. */
export function stepOf(data: Record<string, unknown>): { id: string; name: string; depth?: number } | null {
  const s = data.step as { stepNumber?: unknown; name?: unknown; path?: unknown; depth?: unknown } | undefined;
  if (!s || (typeof s.stepNumber !== "number" && typeof s.path !== "string")) return null;
  const id = typeof s.path === "string" ? s.path : String(s.stepNumber);
  return { id, name: typeof s.name === "string" ? s.name : id, ...(typeof s.depth === "number" && s.depth > 0 ? { depth: s.depth } : {}) };
}

/** A flow.* event folded into the card's steps. */
export function applyStepEvent(steps: FlowStepProgress[], e: FlowEventLike): boolean {
  const d = e.data ?? {};
  const step = stepOf(d);
  if (!step) return false;
  let row = steps.find((s) => s.id === step.id);
  if (!row) {
    row = { ...step, state: "running" };
    steps.push(row);
  }
  if (e.type === "flow.step_started") row.state = "running";
  else if (e.type === "flow.step_failed") {
    row.state = "failed";
    const m = (d.error as { message?: unknown } | undefined)?.message;
    if (typeof m === "string") row.error = m;
  } else if (e.type === "flow.step_completed") {
    const r = d.result as { success?: boolean; skipped?: boolean; error?: { message?: string } } | undefined;
    row.state = r?.skipped ? "skipped" : r?.success === false ? "failed" : "done";
    if (r?.success === false && r.error?.message) row.error = r.error.message;
  } else return false;
  return true;
}

/** The answer of POST /v1/flows/<name>/run as an outcome. */
export function flowOutcome(status: number, body: Record<string, unknown>): FlowCallOutcome {
  const reports = (Array.isArray(body.steps) ? body.steps : []) as StepReport[];
  const steps: FlowStepProgress[] = reports.map((s, i) => ({
    id: String(s.stepNumber ?? i + 1),
    name: s.name ?? `Step ${i + 1}`,
    state: s.skipped ? "skipped" : s.success ? "done" : "failed",
    ...(s.error?.message ? { error: s.error.message } : {}),
  }));
  const summary = typeof body.summary === "string" && body.summary.trim() ? body.summary.trim() : undefined;
  const duration = typeof body.duration === "number" ? body.duration : undefined;
  const success = status >= 200 && status < 300 && body.success === true;
  if (success) return { success, summary, errors: [], duration, steps };
  const errors = reports.flatMap((s) => (s.success || s.skipped || !s.error?.message ? [] : [s.name ? `${s.name}: ${s.error.message}` : s.error.message]));
  if (!errors.length && typeof body.error === "string") errors.push(body.error);
  if (!errors.length && !summary) errors.push(`The flow answered ${status} without saying why.`);
  return { success, summary, errors, duration, steps };
}

/**
 * Runs flows for /flow. One at a time per daemon, so a run's events are told
 * apart from another run of the same flow.
 */
export class FlowCaller {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: FlowCallOptions) {}

  run(name: string, params: Record<string, unknown>, onEvent: (e: FlowEventLike) => void, signal: AbortSignal): Promise<FlowCallOutcome> {
    const next = this.queue.then(() => this.runOne(name, params, onEvent, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runOne(name: string, params: Record<string, unknown>, onEvent: (e: FlowEventLike) => void, signal: AbortSignal): Promise<FlowCallOutcome> {
    const fail = (error: string): FlowCallOutcome => ({ success: false, errors: [error], steps: [] });
    if (signal.aborted) return fail("Stopped.");
    const end = this.o.endpoint();
    if (!end) return fail("The daemon's address could not be read, so the flow could not start.");
    let runId: string | null = null;
    const unsubscribe = this.o.subscribe((e) => {
      if (!e.type.startsWith("flow.")) return;
      const d = e.data ?? {};
      if (d.flowName !== name && runId === null) return;
      if (e.type === "flow.run_started" && runId === null) runId = String(d.runId ?? "");
      if (runId === null || d.runId !== runId) return;
      onEvent(e);
    });
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`http://127.0.0.1:${end.port}/v1/flows/${encodeURIComponent(name)}/run`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${end.token}` },
        body: JSON.stringify({ params }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return flowOutcome(res.status, body);
    } catch (e) {
      return fail(signal.aborted ? "Stopped." : e instanceof Error ? e.message : String(e));
    } finally {
      unsubscribe();
    }
  }
}
