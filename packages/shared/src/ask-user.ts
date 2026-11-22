/**
 * The main agent's ask_user question, as the form card it raises: the
 * question, two to six options, and an optional answer in the user's own
 * words. The agent builds the form with askUserFields; a client that knows
 * the shape (askUserForm) shows each option as a button that answers at once,
 * and any other client shows it as an ordinary form.
 */
import type { FormField } from "./index.js";

/** The tool's name, which is also the form's `call`. */
export const ASK_USER_TOOL = "ask_user";
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 6;
/** The field holding the chosen option. */
export const ASK_USER_CHOICE = "choice";
/** The field holding an answer in the user's own words, when the question allows one. */
export const ASK_USER_OTHER = "other";

/** The form's fields and required list for a question with these options. */
export function askUserFields(options: string[], other: boolean): { fields: Record<string, FormField>; required: string[] } {
  const fields: Record<string, FormField> = { [ASK_USER_CHOICE]: { type: "string", title: "Choice", enum: options } };
  if (other) fields[ASK_USER_OTHER] = { type: "string", title: "Something else", description: "Your own answer, sent instead of the choice" };
  return { fields, required: other ? [] : [ASK_USER_CHOICE] };
}

/** An ask_user form's question and options; null for any other form. */
export function askUserForm(form: { call: string; message: string; fields: Record<string, unknown> }): { question: string; options: string[]; other: boolean } | null {
  if (form.call !== ASK_USER_TOOL) return null;
  const choice = form.fields[ASK_USER_CHOICE] as { enum?: unknown } | undefined;
  const options = Array.isArray(choice?.enum) ? choice.enum.filter((o): o is string => typeof o === "string") : [];
  if (options.length < ASK_USER_MIN_OPTIONS) return null;
  return { question: form.message, options, other: ASK_USER_OTHER in form.fields };
}
