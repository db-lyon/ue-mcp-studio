/**
 * Which half of the chat a narrow panel shows: below the breakpoint in
 * styles.css the session list and the conversation take turns at the full
 * width. An open session shows the conversation; so does a project with no
 * sessions yet, whose empty conversation is where one starts. Otherwise the
 * list. Wide panels show both and ignore this.
 */
export type ChatPane = "list" | "conversation";

export function chatPane(selected: string | null, listed: boolean, sessions: number): ChatPane {
  if (selected) return "conversation";
  if (listed && sessions === 0) return "conversation";
  return "list";
}
