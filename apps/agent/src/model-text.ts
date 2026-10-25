/**
 * Editor results as the model is given them.
 *
 * Every result stays in the conversation and is read again by every later
 * model call, so its size is paid for many times over. The transcript keeps
 * what ue-mcp answered; the model gets the same content in fewer tokens.
 */

/**
 * A JSON answer without its indentation: ue-mcp answers pretty-printed, and
 * the model reads the same content in a quarter fewer tokens without the
 * whitespace. Anything that is not JSON comes back as it came.
 */
export function compactJson(text: string): string {
  if (!text.includes("\n")) return text;
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return text;
  }
}
