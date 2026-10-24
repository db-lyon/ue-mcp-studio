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
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "playtest", args: "what to test (optional)", summary: "Draft a playtest of what the conversation is about, as a Playtest card" },
];

/** The command a message runs, and the text after its name. Null for an ordinary message. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !SLASH_COMMANDS.some((c) => c.name === m[1])) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/**
 * What the user has typed of a command name, while the draft is only a slash
 * and the start of a name: "/" is "", "/pla" is "pla". Null once anything
 * else is in the draft (a space, a second line, text before the slash).
 */
export function slashQuery(draft: string): string | null {
  const m = /^\/([a-z-]*)$/i.exec(draft);
  return m ? m[1].toLowerCase() : null;
}

/** The commands whose names start with what was typed, in the registry's order. */
export function matchCommands(query: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
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
}
