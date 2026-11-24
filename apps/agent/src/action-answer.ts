/** Reading what ue-mcp answers a call with: its JSON body, and why it failed. */
import type { ActionResult } from "ue-mcp/daemon";

const text = (r: ActionResult): string => r.content.map((c) => c.text ?? "").join("\n");

/** An answer's JSON body, or null when the call failed or said success: false. */
export function answerOf(r: ActionResult | null): Record<string, unknown> | null {
  if (!r || r.isError) return null;
  try {
    const v = JSON.parse(text(r)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return (v as Record<string, unknown>).success === false ? null : (v as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Why a call failed, or null when it worked. */
export function failureOf(r: ActionResult): string | null {
  if (r.isError) return text(r) || "the call failed";
  try {
    const v = JSON.parse(text(r)) as Record<string, unknown> | null;
    if (v && v.success === false) return typeof v.error === "string" ? v.error : "the call failed";
  } catch {
    // Not JSON: not a refusal either.
  }
  return null;
}
