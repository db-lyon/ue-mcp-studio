/**
 * Running one of the project's flows from a client: what the launcher shows
 * while it reads the flow, and the form's values as the run's params.
 */
import { flowValue, singleType, type FlowInput, type FlowListing, type TranscriptEntry } from "@ue-mcp-studio/shared";

/** What the launcher has read: the names to pick from, the closest to a name that is no flow, or the flow's inputs. */
export type FlowLoaded =
  | { kind: "loading" }
  | { kind: "unnamed"; flows: FlowListing[] }
  | { kind: "unknown"; closest: string[] }
  | { kind: "error"; message: string }
  | { kind: "ready"; flow: FlowListing | null; inputs: FlowInput[]; scope: "flat" | "step" };

/** A pair typed after the name, as the value of the field it prefills. */
export function prefillValue(raw: string, input: FlowInput | undefined): unknown {
  const type = input ? singleType(input) : null;
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

/** The form's values as the run's params: text read as the input's type. Pairs typed for no input go too. */
export function flowParamsFrom(inputs: FlowInput[], content: Record<string, unknown>, typed: Record<string, string>): Record<string, unknown> {
  const byName = new Map(inputs.map((i) => [i.name, i]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(typed)) if (!byName.has(k)) out[k] = flowValue(v, null);
  for (const [k, v] of Object.entries(content)) {
    const input = byName.get(k);
    out[k] = typeof v === "string" && input ? flowValue(v, singleType(input)) : v;
  }
  return out;
}

/** The message a step-scoped flow's form cannot address. */
export const FLOW_STEP_SCOPE_ERROR =
  "This flow takes its params per step, and one of them is read by a nested flow's step, a hook step or no step, so this form cannot address it. Run the flow with flow(run) and params per step.";

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
