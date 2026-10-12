/**
 * The chosen effort in each vendor's terms. Claude models take every level
 * as it is; the others take their nearest level, and a model that does not
 * reason is sent none.
 */
import type { Effort } from "@ue-mcp-studio/shared";

/** OpenAI's reasoning models: low to xhigh, so max asks for xhigh. */
export function openaiEffort(model: string, effort: Effort | undefined): string | null {
  if (!effort || !/^(o\d|gpt-5|gpt-6)/.test(model)) return null;
  return effort === "max" ? "xhigh" : effort;
}

/** Gemini's thinking models: low to high. */
export function geminiEffort(model: string, effort: Effort | undefined): string | null {
  if (!effort || !/^gemini-(2\.5|[3-9])/.test(model)) return null;
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/** `{ [key]: { effort } }` when there is a level to send, else nothing. */
export const withEffort = (key: string, effort: string | null): Record<string, unknown> => (effort ? { [key]: { effort } } : {});
