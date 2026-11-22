/**
 * The main agent's tools that reach the user directly: ask_user puts a
 * multiple-choice question to them as a form card in the chat (the same
 * FormBroker cards ue-mcp's elicitations raise) and waits for the answer;
 * notify_user sends a notification through the Notifier's emit, so the
 * project's event switches, a muted session and "viewing this session" still
 * apply, and each device's own rules after that. Only the main agent has
 * them: a subagent reports to the agent that started it, which decides what
 * reaches the user. A subagent's call to one is refused.
 */
import { ASK_USER_CHOICE, ASK_USER_MAX_OPTIONS, ASK_USER_MIN_OPTIONS, ASK_USER_OTHER, ASK_USER_TOOL, askUserFields, type TranscriptEntry } from "@ue-mcp-studio/shared";
import type { ElicitParams, ElicitResult } from "./forms.js";

export const ASK_USER = ASK_USER_TOOL;
export const NOTIFY_USER = "notify_user";
export const USER_TOOL_NAMES: readonly string[] = [ASK_USER, NOTIFY_USER];
export const isUserTool = (name: string): boolean => USER_TOOL_NAMES.includes(name);

/** The most notifications the agent sends in one turn of a session. */
export const NOTICES_PER_TURN = 3;
const MAX_TITLE = 60;
const MAX_TEXT = 160;
const MAX_OPTION = 80;

export const USER_TOOLS = [
  {
    name: ASK_USER,
    description: `Ask the user a question with ${ASK_USER_MIN_OPTIONS} to ${ASK_USER_MAX_OPTIONS} options and wait for the answer. It shows as a card in the chat, on their computer and phone, where they answer with a tap. `
      + "Use it when a choice blocks your work and only the user can make it, such as which of several variants to keep or whether to overwrite an existing asset. "
      + "Decide for yourself whatever you can find out or reasonably choose. The result is the option they chose, their own answer when allow_other is set, or that they declined.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "The question, in one or two plain sentences" },
        options: { type: "array", items: { type: "string" }, minItems: ASK_USER_MIN_OPTIONS, maxItems: ASK_USER_MAX_OPTIONS, description: `${ASK_USER_MIN_OPTIONS} to ${ASK_USER_MAX_OPTIONS} distinct answers, each a few words` },
        allow_other: { type: "boolean", description: "Let the user type an answer of their own instead of an option (default false)" },
      },
      required: ["question", "options"],
    },
  },
  {
    name: NOTIFY_USER,
    description: "Send the user a notification on their phone and computer. Their notification settings decide whether it shows, as they do for Studio's own. "
      + "Use it only for something they would want to be pulled back for while away: a long build, cook or shader compile finished, or a result needs their decision before you can go on. "
      + `They already get one when your turn ends, so never use it for progress or to say you are done. At most ${NOTICES_PER_TURN} per turn.`,
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "A few words naming what happened, such as \"Lighting build finished\"" },
        text: { type: "string", description: "One short sentence of detail" },
      },
      required: ["title", "text"],
    },
  },
];

/** What a subagent's call to one of these tools is answered with. */
export const SUBAGENT_CANNOT_REACH_USER = "Only the main agent can ask the user a question or send them a notification. Put what you need from the user in your report.";

/** What the tools need of the session and its runner. */
export interface UserToolControl {
  /** Raise a form card for this call's session and wait for the answer; absent where no chat takes forms. */
  ask?(params: ElicitParams, signal: AbortSignal): Promise<ElicitResult>;
  /** Emit a notice for this call's session: the notice, or null when the settings held it back. Absent without a notifier. */
  notify?(title: string, text: string): unknown;
  /** Take one of this turn's notifications: false once NOTICES_PER_TURN were sent. */
  takeNotice(): boolean;
}

type Result = { text: string; isError: boolean };
const fail = (text: string): Result => ({ text, isError: true });
const one = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Run one of the tools. `parent`: the agent call of the subagent that made the call, null for the main agent. */
export async function runUserTool(name: string, input: Record<string, unknown>, parent: string | null, c: UserToolControl, signal: AbortSignal): Promise<Result> {
  if (parent) return fail(SUBAGENT_CANNOT_REACH_USER);
  if (name === ASK_USER) return ask(input, c, signal);
  if (name === NOTIFY_USER) return notify(input, c);
  return fail(`Unknown tool ${name}.`);
}

async function ask(input: Record<string, unknown>, c: UserToolControl, signal: AbortSignal): Promise<Result> {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) return fail("Give the question as text.");
  const raw = Array.isArray(input.options) ? input.options : [];
  const options = [...new Set(raw.filter((o): o is string => typeof o === "string").map(one).filter(Boolean))];
  if (options.length < ASK_USER_MIN_OPTIONS || options.length > ASK_USER_MAX_OPTIONS) return fail(`Give ${ASK_USER_MIN_OPTIONS} to ${ASK_USER_MAX_OPTIONS} distinct options as text.`);
  if (options.some((o) => o.length > MAX_OPTION)) return fail(`Keep each option under ${MAX_OPTION} characters; put the detail in the question.`);
  if (!c.ask) return fail("This Studio cannot put a question to the user here. Ask it in your reply instead.");
  const { fields, required } = askUserFields(options, input.allow_other === true);
  const r = await c.ask({ message: question, requestedSchema: { type: "object", properties: fields, required } }, signal);
  if (r.action !== "accept") {
    return r.action === "cancel"
      ? { text: "The question was withdrawn before the user answered: the turn was stopped.", isError: true }
      : { text: "The user declined to answer. Go on without it if you can, or ask in your reply.", isError: false };
  }
  const other = typeof r.content[ASK_USER_OTHER] === "string" ? r.content[ASK_USER_OTHER].trim() : "";
  if (other) return { text: `The user answered in their own words: ${other}`, isError: false };
  const choice = r.content[ASK_USER_CHOICE];
  if (typeof choice === "string" && options.includes(choice)) return { text: `The user chose: ${choice}`, isError: false };
  return { text: "The user sent the card without an answer. Go on without it if you can, or ask in your reply.", isError: false };
}

function notify(input: Record<string, unknown>, c: UserToolControl): Result {
  const title = typeof input.title === "string" ? one(input.title) : "";
  const text = typeof input.text === "string" ? one(input.text) : "";
  if (!title || !text) return fail("Give the notification a title and a text.");
  if (!c.notify) return fail("This Studio cannot send notifications here.");
  if (!c.takeNotice()) return fail(`You already sent ${NOTICES_PER_TURN} notifications this turn, the most one turn sends. The user gets one when your turn ends.`);
  const sent = c.notify(title.slice(0, MAX_TITLE), text.slice(0, MAX_TEXT));
  return sent
    ? { text: "Sent. Each of the user's devices shows it unless its own settings hold it back.", isError: false }
    : { text: "Not sent: the user's settings turn these notifications off for this session, or they have it open in front of them now.", isError: false };
}

/**
 * Notifications sent per turn, per session. A turn is keyed by its session
 * and the place of its last message from the user, so a new message starts a
 * new count.
 */
export class NoticeLimit {
  private readonly sent = new Map<string, { turn: number; count: number }>();

  take(sessionId: string, transcript: readonly TranscriptEntry[]): boolean {
    let turn = -1;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i]!;
      if (e.kind === "user" && !e.parent) {
        turn = i;
        break;
      }
    }
    const cur = this.sent.get(sessionId);
    const count = cur && cur.turn === turn ? cur.count : 0;
    if (count >= NOTICES_PER_TURN) return false;
    if (this.sent.size > 500) this.sent.clear();
    this.sent.set(sessionId, { turn, count: count + 1 });
    return true;
  }
}
