/**
 * Running one of the project's flows from a client: what the launcher shows
 * while it reads the flow, and how a flow's card names its state. The form's
 * params are launchers.ts.
 */
import type { FlowInput, FlowListing, TranscriptEntry } from "@ue-mcp-studio/shared";

/** What the launcher has read: the names to pick from, the closest to a name that is no flow, or the flow's inputs. */
export type FlowLoaded =
  | { kind: "loading" }
  | { kind: "unnamed"; flows: FlowListing[] }
  | { kind: "unknown"; closest: string[] }
  | { kind: "error"; message: string }
  | { kind: "ready"; flow: FlowListing | null; inputs: FlowInput[]; scope: "flat" | "step" };

export type FlowEntry = Extract<TranscriptEntry, { kind: "flow" }>;

export const FLOW_STATE_LABEL: Record<FlowEntry["state"], string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
};

/** "Succeeded in 4.2 s". */
export const flowStateLine = (e: Pick<FlowEntry, "state" | "duration">): string =>
  `${FLOW_STATE_LABEL[e.state]}${e.duration !== undefined ? ` in ${(e.duration / 1000).toFixed(1)} s` : ""}`;
