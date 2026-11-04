/** A form ue-mcp raised (an elicitation, or /flow's inputs): what each field starts at and what Submit sends. */
import type { FormField } from "@ue-mcp-studio/shared";

/** Each field's starting value: its default, else off, the first choice, or empty. */
export const formInitial = (fields: Record<string, FormField>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.default ?? (f.type === "boolean" ? false : f.type === "string" && f.enum ? f.enum[0] : "")]));

/** What a form sends: the filled-in values, numbers as numbers, blanks left out. */
export function formContent(fields: Record<string, FormField>, values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "").map(([k, v]) => {
    const f = fields[k];
    return [k, f && (f.type === "number" || f.type === "integer") ? Number(v) : v];
  }));
}
