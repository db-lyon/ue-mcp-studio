/**
 * One Update as its steps, the shape Studio's agent keeps and sends in
 * studio.update.run events, with the words a client shows for each step.
 * Running an update is the computer's own Studio's (apps/client-web
 * views/update-run.ts); a paired client only follows it.
 */
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

export const STEP_NAME: Record<StepKey, string> = { ueMcp: "Bridge plugin", plugin: "Editor plugin", studio: "Studio", restart: "Restart ue-mcp" };
export const STEP_NOTE: Partial<Record<StepKey, string>> = {
  plugin: "The editor closes and reopens. Studio comes back with it.",
  studio: "ue-mcp restarts. This panel reloads when it is back.",
  restart: "ue-mcp restarts. This panel reloads when it is back.",
};

/** The steps the agent keeps until no turn is in progress. */
export const waitingSteps = (run: UpdateRun): StepKey[] => run.steps.filter((s) => s.state === "deferred").map((s) => s.key);
