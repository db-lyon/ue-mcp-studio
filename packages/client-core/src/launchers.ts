/**
 * The /flow launcher's rules with no UI: what a pair typed after the flow's
 * name prefills, and the run's params from the form.
 */
import { flowValue, singleType, type FlowInput } from "@ue-mcp-studio/shared";

/** A pair typed after the name, as the value of the field it prefills. */
export function flowPrefillValue(raw: string, input: FlowInput | undefined): unknown {
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
export const STEP_SCOPED_UNREACHABLE =
  "This flow takes its params per step, and one of them is read by a nested flow's step, a hook step or no step, so this form cannot address it. Ask the agent to run it with flow(run) and params per step.";
