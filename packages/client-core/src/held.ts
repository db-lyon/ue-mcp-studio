/**
 * A run holding at a manual step for the person's verdict, as both clients
 * show it in the app's bar: which run, the countdown to the deadline the
 * agent set, and the words. The agent owns the list and the deadline
 * (GET /qa/held, studio.qa.held); clients only draw them.
 */
import { HUB_LEASE, QA_VERDICT_WAIT_CHOICES, type EditorLease, type QaHeld } from "@ue-mcp-studio/shared";

/**
 * The hub's hold on the editor (GET /hub/lease, studio.hub.lease), which
 * both clients show as an app bar beside the verdict bar, with one control
 * that takes the editor back.
 */
export function leaseOfEvent(e: { type: string; data?: unknown }): { lease: EditorLease | null } | null {
  if (e.type !== HUB_LEASE) return null;
  const lease = (e.data as { lease?: unknown } | undefined)?.lease;
  return { lease: lease && typeof lease === "object" ? (lease as EditorLease) : null };
}

export const LEASE_COPY = {
  holding: "Studio is running a playtest",
  release: "Release the editor",
  releaseHelp: "Stop the playtest or fix Studio started, end the Play In Editor session it started, and pause Studio's queue",
} as const;

/** The event that carries the whole list whenever it changes. */
export const HELD_EVENT = "studio.qa.held";

/** The list a studio.qa.held event carries, or null for anything else. */
export function heldOfEvent(e: { type: string; data?: unknown }): QaHeld[] | null {
  if (e.type !== HELD_EVENT) return null;
  const held = (e.data as { held?: unknown } | undefined)?.held;
  return Array.isArray(held) ? (held as QaHeld[]) : null;
}

/** The run the bar shows: the one that has waited longest. */
export const heldForBar = (held: readonly QaHeld[]): QaHeld | null => held[0] ?? null;

/** Time left before the run stops, as the bar counts it down: "7:42", "1:02:05", never below 0:00. */
export function heldLeft(dueAt: string, now: number): string {
  const s = Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The "Wait for a verdict" setting's choices as a segmented control takes them: the minutes as the id, a short name. */
export const VERDICT_WAIT_OPTIONS: ReadonlyArray<{ id: string; name: string }> = QA_VERDICT_WAIT_CHOICES.map((m) => ({ id: String(m), name: `${m} min` }));

export const HELD_COPY = {
  /** The bar's line: what waits, and where. */
  waiting: (h: Pick<QaHeld, "scriptName" | "step">) => `Waiting for your verdict: ${h.scriptName}, step ${h.step + 1}`,
  endsIn: (left: string) => `Ends in ${left}`,
  paused: "Play In Editor is paused.",
  resume: "Resume and watch",
  resumeHelp: "Play In Editor runs again; the step still waits for your verdict.",
  stopNow: "Stop now",
  stopNowHelp: "Stop the run and Play In Editor now",
  openCard: "Open card",
  verdictWait: "Wait for a verdict",
  verdictWaitHelp: "How long a playtest holds at a manual step, with Play In Editor paused, before it stops without a verdict.",
} as const;
