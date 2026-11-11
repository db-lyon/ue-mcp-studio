/**
 * Slash commands: a message that starts with /name runs that command instead
 * of an ordinary turn. The composer offers them as the user types / at the
 * start of a message, and the agent runs the ones it is sent. Only names in
 * SLASH_COMMANDS are commands; any other text that starts with / is a message.
 */

export interface SlashCommand {
  /** Typed after the slash. */
  name: string;
  /** What may follow the name, shown in the menu. */
  args?: string;
  /** One line on what it does. */
  summary: string;
  /** Other names that run it. */
  aliases?: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "playtest", args: "what to test (optional)", summary: "Draft a playtest of what the conversation is about, as a Playtest card" },
  { name: "flow", args: "flow name, then key=value (optional)", summary: "Run one of the project's flows, with a form for its inputs" },
  { name: "action", args: "category.method, then key=value (optional)", summary: "Run one ue-mcp action directly, with a form for its parameters" },
  { name: "compact", args: "what the summary must keep (optional)", summary: "Summarize the conversation to free context; the transcript stays as it is" },
];

/**
 * /remote (or /rc): the client answers it itself, never the agent, and offers
 * it only to an account that may use remote control or, while the plan is
 * offered, may read about it (remoteSurface).
 */
export const REMOTE_COMMAND: SlashCommand = { name: "remote", aliases: ["rc"], summary: "Use this project from your phone or another computer" };

/** Whether a message is exactly this client-side command, by its name or an alias. */
export function isLocalCommand(text: string, command: SlashCommand): boolean {
  const m = /^\/([a-z][a-z-]*)$/.exec(text.trim());
  return !!m && (m[1] === command.name || (command.aliases ?? []).includes(m[1]));
}

/** Commands whose text is free, so they may be typed anywhere in a message: "okay, time to /playtest". */
const ANYWHERE = new Set(["playtest", "compact"]);

/** Whether a command runs from the middle of a message, not only from its start. */
export const slashRunsAnywhere = (name: string): boolean => ANYWHERE.has(name);

/**
 * The command a message runs, and the text after its name. Null for an
 * ordinary message. A command that takes free text also runs from the middle
 * of a message, as a word of its own; the rest of the message is its text.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const t = text.trim();
  const m = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(t);
  if (m && SLASH_COMMANDS.some((c) => c.name === m[1])) return { name: m[1], args: (m[2] ?? "").trim() };
  for (const w of t.matchAll(/(^|\s)\/([a-z][a-z-]*)(?=\s|$)/g)) {
    if (!ANYWHERE.has(w[2])) continue;
    const at = w.index! + w[1].length;
    const args = `${t.slice(0, at)} ${t.slice(at + w[2].length + 1)}`.replace(/\s+/g, " ").trim();
    return { name: w[2], args };
  }
  return null;
}

/**
 * What the user has typed of a command name, while the draft ends in a slash
 * and the start of a name, at the start or after a space: "/" is "", "okay
 * /pla" is "pla". Null once the name is followed by anything.
 */
export function slashQuery(draft: string): string | null {
  const m = /(?:^|\s)\/([a-z-]*)$/i.exec(draft);
  return m ? m[1].toLowerCase() : null;
}

/** The draft before the command name being typed, which a pick from the menu keeps: "okay " for "okay /pla". */
export function slashPrefix(draft: string): string {
  const m = /(?:^|\s)\/[a-z-]*$/i.exec(draft);
  return m ? draft.slice(0, m.index + (m[0].startsWith("/") ? 0 : 1)) : "";
}

/** The commands whose names start with what was typed, in the registry's order. */
export function matchCommands(query: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.startsWith(q) || (c.aliases ?? []).some((a) => a.startsWith(q)));
}

/** Where a /playtest's flow is: gathering context, drafting, checking the draft, created. */
export type PlaytestStage = "gathering" | "drafting" | "checking" | "created";

/**
 * POST /v1/ext/studio/sessions/:id/playtest, and what a /playtest message
 * sends: ue-mcp's playtest flow, which saves a playtest with pie(script_create).
 * `text` is what the user wants tested; `source` the transcript index of the
 * agent message it is made from ("Make playtest" on that message).
 */
export interface PlaytestRequest {
  text: string;
  source?: number;
  /**
   * The Make playtest pill: the turn it is made from, by the transcript index
   * that began it. The turn's changed assets and actors are the target, and
   * the turn is the context.
   */
  turn?: number;
}
