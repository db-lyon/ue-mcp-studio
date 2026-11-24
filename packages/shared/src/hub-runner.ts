/**
 * The runner editor (Playtest Hub decision 15, docs/plans/playtest-hub/
 * runner-editor.md): a second editor of the project, offscreen and saving
 * nothing, that plays unattended plans so they never wait on or touch the
 * developer's editor. The agent starts it for an unattended plan and stops it
 * after a while idle. It holds a lease of its own, apart from the workspace
 * editor's (studio.hub.lease), so the app's lease bar never shows for it.
 *
 * It needs ue-mcp to run a second, read-only editor of one project (asks 13
 * and 14 in ue-mcp-asks.md). Until a daemon offers that, `supported` is false
 * and unattended plans run on the workspace editor under its lease.
 */

/** "running": it plays one of the hub's items now; "ready": started and idle. */
export type RunnerState = "stopped" | "starting" | "ready" | "running" | "stopping";

export interface RunnerView {
  state: RunnerState;
  /** What it plays while running, as the lease names it: "Run all: Door opens". */
  purpose: string | null;
  /** Why it last failed to start, while stopped. */
  error: string | null;
}

/** The body of `studio.hub.runner` (HUB_RUNNER) and of GET /hub/runner. */
export interface HubRunnerEvent {
  /** This ue-mcp can run a runner editor. */
  supported: boolean;
  /** Null while there is none: unsupported, the runnerEditor setting off, or the hub off. */
  runner: RunnerView | null;
}
export const HUB_RUNNER = "studio.hub.runner";

/** The runner's routes, under /v1/ext/studio, beside HUB_ROUTES. */
export const HUB_RUNNER_ROUTES = {
  runner: "GET /hub/runner -> HubRunnerEvent",
  stopRunner: "POST /hub/runner/stop -> HubRunnerEvent (a playtest playing there goes back to the front of the queue, and the queue pauses)",
} as const;
