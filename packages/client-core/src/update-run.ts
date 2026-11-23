/**
 * One Update as its steps, the shape Studio's agent keeps and sends in
 * studio.update.run events, with the words a client shows for each step.
 * Running an update is the computer's own Studio's (apps/client-web
 * views/update-run.ts); a paired client only follows it.
 */
import { consentRequestOf, type EditorDisruptionRequest } from "./editor-consent.js";

export type StepKey ="ueMcp" | "plugin" | "studio" | "restart";
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
  /**
   * The run is held by ue-mcp's editor consent gate: other sessions are using
   * the editor a step would close. Every client shows who and why, with Update
   * anyway (the request approved) and Cancel (denied).
   */
  consent?: EditorDisruptionRequest;
  /** The person chose Update anyway: the run's editor steps go ahead whatever the sessions answer. */
  force?: boolean;
}

export const STEP_NAME: Record<StepKey, string> = { ueMcp: "Bridge plugin", plugin: "Editor plugin", studio: "Studio", restart: "Restart ue-mcp" };
export const STEP_NOTE: Partial<Record<StepKey, string>> = {
  plugin: "The editor closes and reopens. Studio comes back with it.",
  studio: "ue-mcp restarts. This panel reloads when it is back.",
  restart: "ue-mcp restarts. This panel reloads when it is back.",
};

/**
 * An Update the editor consent gate holds, as Studio's agent publishes it
 * (studio.update.consent) and GET /updates/consent answers it. `panel`: the
 * computer's Studio runs the held step once the request is decided; `queue`:
 * the agent runs it, a step that waited for the turns to finish.
 */
export interface UpdateHold {
  request: EditorDisruptionRequest;
  source: "panel" | "queue";
}

/** The hold in a studio.update.consent event's data or GET /updates/consent's answer, or null. */
export function holdOf(v: unknown): UpdateHold | null {
  const raw = (v && typeof v === "object" ? (v as { hold?: unknown }).hold : null) as { request?: unknown; source?: unknown } | null | undefined;
  const request = raw?.request ? consentRequestOf({ status: 409, body: { request: raw.request } }) : null;
  return request && (raw?.source === "panel" || raw?.source === "queue") ? { request, source: raw.source } : null;
}

/** Why a held update stopped when nobody answered its request in time (the agent's update-queue says the same). */
export const HOLD_EXPIRED = "The request to close the editor expired before anyone approved it, so the update stopped before closing the editor.";

/** A stopped update on a paired device: the way on is the computer's own Update. */
export const UPDATE_RETRY_ON_COMPUTER = "To try again, choose Update in Studio on the computer.";

/** The steps the agent keeps until no turn is in progress. */
export const waitingSteps = (run: UpdateRun): StepKey[] => run.steps.filter((s) => s.state === "deferred").map((s) => s.key);

/** What restarts once the waiting steps run, which the agent does once every session is idle (update-queue.ts). */
export function waitingWho(steps: StepKey[]): string {
  const studio = steps.some((k) => k === "studio" || k === "restart");
  const editor = steps.includes("plugin");
  return studio && editor ? "The editor and Studio restart" : editor ? "The editor restarts" : "Studio restarts";
}
