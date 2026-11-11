/**
 * What the composer's slash and @-mention menus list and say, with no UI:
 * the rows for what is typed, and the mention menu's status and notes.
 */
import {
  SLASH_COMMANDS,
  actionNameQuery,
  flowNameQuery,
  matchActions,
  matchCommands,
  matchFlows,
  slashPrefix,
  slashQuery,
  slashRunsAnywhere,
  type ActionListing,
  type FlowListing,
  type MentionKind,
  type MentionQuery,
  type MentionSearchResponse,
  type SlashCommand,
} from "@ue-mcp-studio/shared";

/** A row of the slash menu: a command, a flow's name after /flow, or an action's after /action. `insert` is the message a pick leaves. */
export interface SlashMenuItem {
  key: string;
  label: string;
  args?: string;
  summary?: string;
  insert: string;
}

/** What the draft asks the slash menu for: a command's name, a flow's after /flow, an action's after /action. Null where it asks nothing. */
export function slashQueries(draft: string, commands: readonly SlashCommand[] = SLASH_COMMANDS, flows: boolean, actions: boolean): { query: string | null; flowQuery: string | null; actionQuery: string | null; prefix: string } {
  return {
    query: slashQuery(draft),
    // The text before a command typed mid-message, kept by a pick.
    prefix: slashPrefix(draft),
    flowQuery: flows && commands.some((c) => c.name === "flow") ? flowNameQuery(draft) : null,
    actionQuery: actions && commands.some((c) => c.name === "action") ? actionNameQuery(draft) : null,
  };
}

export const actionMenuItems = (actionQuery: string | null, actions: ActionListing[]): SlashMenuItem[] =>
  actionQuery === null ? [] : matchActions(actionQuery, actions).map((a) => ({ key: a.name, label: a.name, summary: a.summary, insert: `/action ${a.name} ` }));

/** The slash menu's rows for what is typed. */
export function slashMenuItems(q: { query: string | null; flowQuery: string | null; prefix?: string }, commands: readonly SlashCommand[], flows: FlowListing[], actionItems: SlashMenuItem[]): SlashMenuItem[] {
  const prefix = q.prefix ?? "";
  // Mid-message, only the commands that run from there are offered.
  const offered = prefix ? commands.filter((c) => slashRunsAnywhere(c.name)) : commands;
  return q.query !== null
    ? matchCommands(q.query, offered).map((c) => ({ key: c.name, label: `/${c.name}`, args: c.args, summary: c.summary, insert: `${prefix}/${c.name} ` }))
    : q.flowQuery !== null
      ? matchFlows(q.flowQuery, flows).map((f) => ({ key: f.name, label: f.name, summary: f.description, insert: `/flow ${f.name} ` }))
      : actionItems;
}

/** A flow or action name typed out in full is picked already: the menu stays out of the way of Enter. */
export function slashPickedAlready(q: { flowQuery: string | null; actionQuery: string | null }, items: SlashMenuItem[]): boolean {
  return (q.flowQuery !== null && items.length === 1 && items[0].label === q.flowQuery)
    || (q.actionQuery !== null && items[0]?.label.toLowerCase() === q.actionQuery.toLowerCase());
}

/** The slash menu's name for a screen reader. */
export const slashMenuLabel = (q: { flowQuery: string | null; actionQuery: string | null }): string =>
  q.flowQuery !== null ? "Flows" : q.actionQuery !== null ? "Actions" : "Commands";

export const MENTION_KIND_LABEL: Record<MentionKind, string> = { asset: "Asset", actor: "Actor", file: "File" };

/** What a mention looks for, in words. */
export const mentionKindWords = (kinds?: MentionKind[]): string => {
  if (!kinds || kinds.length !== 1) return "assets, actors or files";
  return `${kinds[0]}s`;
};

/** One search's key: its kinds and its query, case folded. */
export const mentionKey = (query: string, kinds?: MentionKind[]): string => `${kinds?.join(",") ?? "*"}|${query.toLowerCase()}`;

/** Why some kinds of name could not be looked up, from a fresh answer's sources. */
export function mentionNotes(sources: MentionSearchResponse["sources"]): string[] {
  return [
    sources.actor === "unavailable" ? "Actors need the editor connected and not busy." : null,
    sources.asset === "disk" ? "Assets are read from disk while the editor is not answering." : null,
  ].filter((n): n is string => !!n);
}

/** The line under the mention menu's rows, or null when the rows say it all. */
export function mentionStatus({ q, items, searching, failed, fresh, sources }: {
  q: Pick<MentionQuery, "query" | "kinds"> | null;
  items: number;
  searching: boolean;
  /** The search for what is typed now failed. */
  failed: boolean;
  fresh: boolean;
  sources: MentionSearchResponse["sources"];
}): string | null {
  if (q && !q.query.trim()) return `Type a name to find ${mentionKindWords(q.kinds)}.`;
  if (items === 0 && searching) return "Searching";
  if (items === 0 && failed) return "Search failed. Keep typing to try again.";
  // Nothing asked could be looked up: the note says why, not that nothing matched.
  const all = Object.values(sources);
  if (items === 0 && q && !(fresh && all.length > 0 && all.every((v) => v === "unavailable"))) return `No ${mentionKindWords(q.kinds)} match ${q.query}.`;
  return null;
}
