/**
 * Reading the steps of an editor operation the daemon ran (start, stop,
 * restart, rebuild).
 *
 * A step is failed when the daemon says so, and also when its handler returned
 * `success: false`: daemons up to ue-mcp 1.4.3 marked those steps ok, so a
 * failed build went on to a launch, and a launch that never became ready read
 * as done (#1384).
 */

export interface OperationStep {
  step: string;
  ok: boolean;
  result?: string;
}

/** The JSON object a step's text starts with, or null when it is not one. */
export function stepPayload(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const parse = (t: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(t);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = parse(text);
  if (whole) return whole;
  // The handler's JSON comes first; notes the daemon adds follow it on their own lines.
  for (let i = text.indexOf("\n}"); i >= 0; i = text.indexOf("\n}", i + 1)) {
    const head = parse(text.slice(0, i + 2));
    if (head) return head;
  }
  return null;
}

/** Whether a step failed. An editor that was already up with its bridge answering is not a failure. */
export function stepFailed(s: OperationStep): boolean {
  if (!s.ok) return true;
  const p = stepPayload(s.result);
  if (!p || p.success !== false) return false;
  return !(p.alreadyRunning === true && p.bridgeReady === true);
}

/** The first failed step, or undefined when every step went through. */
export function firstFailedStep(steps: OperationStep[]): OperationStep | undefined {
  return steps.find(stepFailed);
}

/** A failed step's reason in a sentence or two: its message, or the start of its text. */
export function stepReason(s: OperationStep, max = 600): string {
  const p = stepPayload(s.result);
  const message = typeof p?.message === "string" ? p.message : typeof p?.error === "string" ? p.error : null;
  const text = (message ?? s.result ?? "").trim() || `${s.step} failed`;
  return text.length > max ? text.slice(0, max) : text;
}
