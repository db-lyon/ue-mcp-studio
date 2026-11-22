/**
 * The main agent's tools for the subagents of its session: list them, read
 * one's thread, message a running one, stop one. They act through the same
 * paths as the chat's subagent cards (AgentRunner.messageSubagent and
 * stopSubagent), so a stop or a message from the agent leaves the same state
 * as the user's, on every route. Only the main agent has them; a subagent's
 * call to one is refused, as its call to the agent tool is.
 */
import { agentThreadPage, sessionAgents, type SessionAgent, type ToolCallRecord, type TranscriptEntry, type TurnStatus } from "@ue-mcp-studio/shared";

export const AGENT_LIST = "agent_list";
export const AGENT_READ = "agent_read";
export const AGENT_MESSAGE = "agent_message";
export const AGENT_STOP = "agent_stop";
export const SUBAGENT_TOOL_NAMES: readonly string[] = [AGENT_LIST, AGENT_READ, AGENT_MESSAGE, AGENT_STOP];
export const isSubagentTool = (name: string): boolean => SUBAGENT_TOOL_NAMES.includes(name);

const ID = { type: "string", description: "The subagent's id: its agent call id, as agent_list shows it" };

export const SUBAGENT_TOOLS = [
  {
    name: AGENT_LIST,
    description: "List the subagents of this session, running and finished, with each one's id, task, state and number of steps.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: AGENT_READ,
    description: "Read the newest entries of one subagent's thread: what it wrote, the calls it made with their results, the messages it was sent, and its report once it has ended.",
    input_schema: {
      type: "object" as const,
      properties: { id: ID, entries: { type: "number", description: "How many of its newest entries to read (default 20, at most 100)" } },
      required: ["id"],
    },
  },
  {
    name: AGENT_MESSAGE,
    description: "Send a message to a running subagent. It reads it at its next step, without stopping, and its report still comes to you as usual. "
      + "Use it to correct or narrow its task. A subagent that has ended cannot read one: start it again with the agent tool's resume.",
    input_schema: {
      type: "object" as const,
      properties: { id: ID, text: { type: "string", description: "The message, as the subagent reads it" } },
      required: ["id", "text"],
    },
  },
  {
    name: AGENT_STOP,
    description: "Stop a running or queued subagent, as the Stop on its card in the chat does. Its calls still running are ended and its card shows it stopped. "
      + "To go on with its work later, call the agent tool with resume set to its id.",
    input_schema: { type: "object" as const, properties: { id: ID }, required: ["id"] },
  },
];

/** What a subagent's call to one of these tools is answered with. */
export const SUBAGENT_CANNOT_MANAGE = "Only the main agent can list, read, message or stop subagents.";

/**
 * How a message from the main agent begins, in the subagent's conversation
 * and in its thread, where the user reads it too (the user's own begin with
 * SUBAGENT_MESSAGE_PREFIX in the conversation).
 */
export const AGENT_MESSAGE_PREFIX = "Message from the main agent";

/** The main agent's message as the subagent's conversation and its thread hold it. */
export const fromAgent = (text: string): string => `${AGENT_MESSAGE_PREFIX}:\n\n${text.trim()}`;
export const isFromAgent = (text: string): boolean => text.startsWith(AGENT_MESSAGE_PREFIX);

/** A subagent's report when the main agent stopped it. */
export const AGENT_STOPPED = "You stopped this subagent with agent_stop before it finished.";

/** What the tools need of the session and its runner. */
export interface SubagentControl {
  transcript: readonly TranscriptEntry[];
  status: TurnStatus;
  /** Tool call ids waiting for the user's approval. */
  asked: ReadonlySet<string>;
  /** Its subagent is running or queued and takes a message now. */
  canMessage(callId: string): boolean;
  /** The user started it from the chat, so it is theirs to steer. */
  assigned(callId: string): boolean;
  /** Steer the main agent's message into its run; false when it could not take it. */
  message(callId: string, text: string): Promise<boolean>;
  /** Stop it as the user's Stop does; false when nothing of that id runs. */
  stop(callId: string): boolean;
}

type Result = { text: string; isError: boolean };
const fail = (text: string): Result => ({ text, isError: true });

/** Run one of the tools. `parent`: the agent call of the subagent that made the call, null for the main agent. */
export async function runSubagentTool(name: string, input: Record<string, unknown>, parent: string | null, c: SubagentControl): Promise<Result> {
  if (parent) return fail(SUBAGENT_CANNOT_MANAGE);
  const agents = sessionAgents(c.transcript, { status: c.status, asked: c.asked, messageable: (id) => c.canMessage(id) });
  if (name === AGENT_LIST) return { text: listText(agents, c), isError: false };
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const agent = agents.find((a) => a.id === id);
  if (!agent) return fail(id ? `No subagent of this session has the id ${id}. Call agent_list for the ids.` : "Give the subagent's id. Call agent_list for the ids.");
  const ended = !OPEN.has(agent.state);
  switch (name) {
    case AGENT_READ:
      return { text: readText(agent, c.transcript, input.entries), isError: false };
    case AGENT_MESSAGE: {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return fail("Give the message as text.");
      if (ended) return fail(`${label(agent)} has ended (${agent.state}), so it cannot read a message. Call the agent tool with resume set to ${agent.id} and your message as the prompt to go on in its conversation.`);
      if (c.assigned(agent.id)) return fail(`The user started ${label(agent)} from the chat, so only the user can message it. Ask them to write to it from its thread.`);
      if (!c.canMessage(agent.id) || !(await c.message(agent.id, text))) {
        return fail(`${label(agent)} cannot take a message where it runs. Stop it with agent_stop, then call the agent tool with resume set to ${agent.id} and your message as the prompt.`);
      }
      return { text: `Sent. ${label(agent)} reads it at its next step.`, isError: false };
    }
    case AGENT_STOP:
      if (ended) return { text: `${label(agent)} has already ended (${agent.state}).`, isError: false };
      if (c.assigned(agent.id)) return fail(`The user started ${label(agent)} from the chat, so only the user can stop it. Ask them to stop it from its card.`);
      if (!c.stop(agent.id)) return fail(`Studio could not stop ${label(agent)}: it is not running in this Studio. Ask the user to stop it from its card.`);
      return { text: `Stopped ${label(agent)}. To go on with its work, call the agent tool with resume set to ${agent.id}.`, isError: false };
    default:
      return fail(`Unknown tool ${name}.`);
  }
}

const OPEN = new Set<SessionAgent["state"]>(["queued", "working", "approval", "waiting"]);

const STATE: Record<SessionAgent["state"], string> = {
  queued: "queued, waiting for a free slot",
  working: "working",
  approval: "waiting for the user to approve a call",
  waiting: "waiting for the editor",
  done: "finished",
  failed: "failed",
  unknown: "ended with an unknown outcome",
  stopped: "stopped",
};

const descriptionOf = (call: ToolCallRecord): string => {
  const d = (call.input as { description?: unknown } | null)?.description;
  return typeof d === "string" && d.trim() ? d.trim() : "subagent";
};
const label = (a: SessionAgent): string => `"${descriptionOf(a.call)}" (${a.id})`;

/** A call in a phrase: its tool, and its ue-mcp action. */
const callName = (call: ToolCallRecord): string => {
  const i = (call.input ?? {}) as Record<string, unknown>;
  return call.name === "ue_mcp" && i.action === "call" ? `ue_mcp ${String(i.category)}.${String(i.method)}` : call.name;
};

function listText(agents: SessionAgent[], c: SubagentControl): string {
  if (!agents.length) return "This session has no subagents.";
  const lines = agents.map((a) => {
    const parts = [`${a.id}: "${descriptionOf(a.call)}"`, a.step && a.state === "working" ? `working on ${callName(a.step)}` : STATE[a.state], `${a.steps} step${a.steps === 1 ? "" : "s"}`, `started ${a.call.startedAt}`];
    if (a.call.endedAt) parts.push(`ended ${a.call.endedAt}`);
    if (c.assigned(a.id)) parts.push("started by the user");
    return `- ${parts.join(", ")}`;
  });
  return `${agents.length} subagent${agents.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

const MAX_TEXT = 2000;
const MAX_RESULT = 600;
const clip = (t: string, max: number): string => (t.length > max ? `${t.slice(0, max)}... (${t.length - max} more characters)` : t);

function entryText(e: TranscriptEntry): string | null {
  switch (e.kind) {
    case "user":
      return isFromAgent(e.text) ? `[your message] ${clip(e.text.slice(AGENT_MESSAGE_PREFIX.length + 1).trim(), MAX_TEXT)}` : `[the user's message] ${clip(e.text, MAX_TEXT)}`;
    case "assistant":
      return `[it wrote] ${clip(e.text, MAX_TEXT)}`;
    case "tool": {
      const input = clip(JSON.stringify(e.call.input ?? {}), MAX_RESULT);
      const result = e.call.result !== undefined ? `\n  ${clip(e.call.result, MAX_RESULT)}` : e.call.resultSize ? `\n  (a result of ${e.call.resultSize} characters)` : "";
      return `[call ${callName(e.call)}, ${e.call.outcome}] ${input}${result}`;
    }
    case "note":
      return `[note] ${clip(e.text, MAX_TEXT)}`;
    case "compaction":
      return "[its conversation was compacted here]";
    default:
      return null;
  }
}

function readText(agent: SessionAgent, transcript: readonly TranscriptEntry[], wanted: unknown): string {
  const n = typeof wanted === "number" && Number.isFinite(wanted) ? Math.min(100, Math.max(1, Math.floor(wanted))) : 20;
  const page = agentThreadPage(transcript, agent.id, { tail: n });
  const head = `${label(agent)}: ${STATE[agent.state]}. Task: ${clip(String((agent.call.input as { prompt?: unknown } | null)?.prompt ?? ""), MAX_TEXT)}`;
  const span = page.total === 0 ? "Its thread has no entries yet." : `Entries ${page.from + 1} to ${page.from + page.entries.length} of ${page.total}:`;
  const lines = page.entries.map(entryText).filter((l): l is string => l !== null);
  const report = OPEN.has(agent.state) ? [] : [`Its report:\n${agent.call.result ?? (agent.call.resultSize ? `(${agent.call.resultSize} characters, shown in its card)` : "(none)")}`];
  return [head, span, ...lines, ...report].join("\n\n");
}
