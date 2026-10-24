/**
 * /playtest: a turn whose one job is to save a playtest with pie(script_create).
 *
 * The turn offers a single tool, ue-mcp's pie category cut down to its
 * script_create action, and forces it with the provider's own tool choice.
 * The Agent SDK cannot force a tool, so on the Claude sign-in that tool is the
 * only one allowed. Either way Studio checks the call itself: any other tool
 * or action is refused. A script_create that fails is answered once more
 * inside the turn; the turn ends with the Draft card or the failure state,
 * never with the model's prose.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { PlaytestRequest } from "@ue-mcp-studio/shared";

export const PIE_TOOL_NAME = "pie";
export const PLAYTEST_ACTION = "script_create";
/** Model calls a /playtest turn makes: the first, and one more after a failed one. */
export const PLAYTEST_ATTEMPTS = 2;

/** What the model is told when the turn ends without a playtest, by the provider path that ran it. */
export const NO_CALL = "The model answered without calling pie(script_create).";

export const PIE_TOOL: Anthropic.Beta.BetaToolUnion = {
  name: PIE_TOOL_NAME,
  description:
    "ue-mcp's pie category, limited to script_create in this turn: saves a PIE test script, a playtest, and Studio shows it as a draft Playtest card. "
    + "Nothing runs it from this turn.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [PLAYTEST_ACTION] },
      name: { type: "string", description: "A short name for the script" },
      steps: {
        type: "array",
        description: "The playtest's steps, in order",
        items: {
          type: "object",
          properties: {
            instruction: { type: "string", description: "What the tester does and what should happen" },
            judge: { type: "string", enum: ["auto", "manual"], description: "auto: the observer decides it from expect; manual: a person judges it" },
            expect: { type: "object", description: "auto steps: { value, op, target, within_ms }, as pie.script_create takes it" },
            agent_judgeable: { type: "boolean", description: "manual steps: false keeps the verdict with a person" },
            player: { type: "string", description: "multiplayer: host, or client 1, client 2 and so on" },
          },
          required: ["instruction", "judge"],
        },
      },
    },
    required: ["action", "name", "steps"],
  },
};

/** Why a call in a /playtest turn must not run, or null when it is pie(script_create). */
export function playtestCallError(name: string, input: unknown): string | null {
  if (name !== PIE_TOOL_NAME) return `This turn allows only the pie tool with action ${PLAYTEST_ACTION}; ${name} was refused.`;
  const action = (input as { action?: unknown } | null)?.action;
  if (action !== PLAYTEST_ACTION) return `This turn allows only pie action ${PLAYTEST_ACTION}; ${String(action)} was refused.`;
  return null;
}

/** The system prompt's line for a /playtest turn. */
export const PLAYTEST_SYSTEM = [
  "This turn is a /playtest. Its one job is to save a playtest: call the pie tool once with action script_create, a short name and the steps.",
  "It is the only tool and the only action this turn. Write no reply: Studio shows the saved script as a draft Playtest card, and nothing you write is shown.",
  "Nothing runs the playtest from this turn. If script_create answers with an error, fix what it names and call it once more.",
].join("\n");

/**
 * The user message a /playtest sends the model: the job, what the user wants
 * tested, the agent message it is made from, and script_create's parameters,
 * since the turn cannot describe the action itself.
 */
export function playtestPrompt(req: PlaytestRequest, source: string | null, describe: string | null): string {
  const lines = [
    "[Studio] The user ran /playtest: save a playtest with pie(script_create) of what this conversation is about.",
    "Base the steps on the conversation so far: the feature, how it is used, and what should happen. Make a step auto with an expect when a value the observer reads decides it, manual when only a person can judge it.",
  ];
  if (req.text.trim()) lines.push(`What the user wants tested: ${req.text.trim()}`);
  if (source) lines.push(`Make it from this message of yours:\n\n${source}`);
  if (describe) lines.push(`pie.script_create, as ue-mcp describes it:\n\n${describe}`);
  return lines.join("\n\n");
}

/** How a /playtest is written in the transcript. */
export const playtestText = (req: PlaytestRequest): string => (req.text.trim() ? `/playtest ${req.text.trim()}` : "/playtest");
