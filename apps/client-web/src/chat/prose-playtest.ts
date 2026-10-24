/**
 * A playtest the agent wrote out as prose instead of running: a numbered list
 * of steps marked PASS or FAIL, in a turn that ran no test script. Studio
 * offers to turn it into a Playtest, which the agent then builds and runs.
 */
import type { TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";

export interface ProseStep {
  /** The step with its markers taken out. */
  instruction: string;
  /** What the prose claimed, when it claimed one. */
  mark: "pass" | "fail" | null;
}

const ITEM = /^ {0,3}(\d{1,2})[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const PASS_WORD = /\bPASS(?:ED)?\b/;
const FAIL_WORD = /\bFAIL(?:ED)?\b/;
const PASS_EMOJI = /(\u2705|\u2714\uFE0F?|\u2611\uFE0F?)/u;
const FAIL_EMOJI = /(\u274C|\u274E|\u2716\uFE0F?|\u2717|\u2718)/u;
const PASS_BOLD = /\*\*\s*pass(?:ed)?\s*\*\*/i;
const FAIL_BOLD = /\*\*\s*fail(?:ed)?\s*\*\*/i;
const PASS_LABEL = /\b(?:result|verdict|status|outcome)\s*:\s*\**\s*pass(?:ed)?\b/i;
const FAIL_LABEL = /\b(?:result|verdict|status|outcome)\s*:\s*\**\s*fail(?:ed)?\b/i;

/** The marker an item carries: pass, fail, both (a PASS / FAIL blank to fill in), or none. */
function markOf(text: string): "pass" | "fail" | "blank" | null {
  const pass = PASS_WORD.test(text) || PASS_EMOJI.test(text) || PASS_BOLD.test(text) || PASS_LABEL.test(text);
  const fail = FAIL_WORD.test(text) || FAIL_EMOJI.test(text) || FAIL_BOLD.test(text) || FAIL_LABEL.test(text);
  if (pass && fail) return "blank";
  return pass ? "pass" : fail ? "fail" : null;
}

/** The step without its markers, bold, brackets and trailing separators. */
function clean(text: string): string {
  return text
    .replace(/\[\s*(?:PASS|FAIL)\s*\/\s*(?:PASS|FAIL)\s*\]/g, "")
    .replace(/\b(?:result|verdict|status|outcome)\s*:\s*\**\s*(?:pass(?:ed)?|fail(?:ed)?)\**/gi, "")
    .replace(/\*\*\s*(?:pass(?:ed)?|fail(?:ed)?)\s*\*\*/gi, "")
    .replace(/\b(?:PASS(?:ED)?|FAIL(?:ED)?)\b/g, "")
    .replace(/(\u2705|\u2714\uFE0F?|\u2611\uFE0F?|\u274C|\u274E|\u2716\uFE0F?|\u2717|\u2718)/gu, "")
    .replace(/\*\*/g, "")
    // What the markers leave behind: empty brackets, a separator before a comma, trailing separators.
    .replace(/\[\s*[/|]?\s*\]|\(\s*\)/g, "")
    .replace(/\s*[:\-\u2013\u2014|]\s*(?=[,(])/gu, " ")
    .replace(/\s+,/g, ",")
    .replace(/([.!?]),/g, "$1")
    .replace(/[\s:,\-\u2013\u2014|/[]+$/u, "")
    .replace(/^[\s:,\-\u2013\u2014|]+/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The steps of a prose playtest in a reply, or null when it has none: at least
 * two numbered items carry a PASS or FAIL marker, and at least half of them do.
 * An ordinary numbered list (how to do something, lowercase "pass" in a
 * sentence) does not count, nor does anything inside a code block.
 */
export function proseSteps(text: string): ProseStep[] | null {
  const lists: string[][] = [];
  let items: string[] = [];
  let fenced = false;
  let blank = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = ITEM.exec(line);
    if (m) {
      items.push(m[2]);
      blank = false;
    } else if (!line.trim()) {
      blank = true;
    } else if (items.length > 0 && (!blank || /^\s/.test(line))) {
      // The item goes on: a wrapped line, or an indented one after a gap.
      items[items.length - 1] += ` ${line.trim()}`;
      blank = false;
    } else if (items.length > 0) {
      // Text after the list ends it.
      lists.push(items);
      items = [];
      blank = false;
    }
  }
  if (items.length > 0) lists.push(items);
  for (const list of lists) {
    const steps = stepsOf(list);
    if (steps) return steps;
  }
  return null;
}

function stepsOf(items: string[]): ProseStep[] | null {
  if (items.length < 2) return null;
  const marks = items.map(markOf);
  const marked = marks.filter((x) => x !== null).length;
  if (marked < 2 || marked * 2 < items.length) return null;
  return items.map((t, i) => ({ instruction: clean(t) || t.trim(), mark: marks[i] === "pass" || marks[i] === "fail" ? (marks[i] as "pass" | "fail") : null }));
}

const STARTS = new Set(["script_run", "script_replay"]);

/** Whether a call ran a test script. */
function ranScript(t: TranscriptEntry): boolean {
  if (t.kind === "qa") return true;
  if (t.kind !== "tool" || t.call.name !== "ue_mcp") return false;
  const input = t.call.input as { action?: unknown; category?: unknown; method?: unknown };
  return input.action === "call" && input.category === "pie" && typeof input.method === "string" && STARTS.has(input.method);
}

const isTurnStart = (t: TranscriptEntry): boolean => t.kind === "user" && !t.parent;

/** What the user sends to turn a prose playtest into a Playtest. */
export const CONVERT_PREFIX = "Turn the steps in your last reply into a Playtest";

/**
 * Whether the reply at `at` is a finished prose playtest worth converting: its
 * turn has ended, ran no test script anywhere (the main agent or a subagent),
 * and the user has not asked to convert it since.
 */
export function offerConversion(transcript: readonly TranscriptEntry[], at: number, status: TurnStatus): ProseStep[] | null {
  const entry = transcript[at];
  if (!entry || entry.kind !== "assistant" || entry.parent) return null;
  let start = at;
  while (start > 0 && !isTurnStart(transcript[start])) start--;
  let end = at + 1;
  while (end < transcript.length && !isTurnStart(transcript[end])) end++;
  const ended = end < transcript.length || (status !== "running" && status !== "waiting");
  if (!ended) return null;
  for (let i = start; i < end; i++) if (ranScript(transcript[i])) return null;
  for (let i = end; i < transcript.length; i++) {
    const t = transcript[i];
    if (t.kind === "user" && t.text.startsWith(CONVERT_PREFIX)) return null;
  }
  return proseSteps(entry.text);
}

/** The message that has the agent build and run the steps as a Playtest. */
export function conversionMessage(steps: ProseStep[]): string {
  return [
    `${CONVERT_PREFIX} and run it. Do not answer with a list.`,
    "Create it with pie.script_create (a short name for the script), one step per item below, in this order:",
    ...steps.map((s, i) => `${i + 1}. ${s.instruction}`),
    "For each step, find a value an observation profile in the project tracks that decides it (look the profiles up with ue_mcp search, read the one that fits and name it as the script's profile). "
      + "When you can name one, make the step auto with an expect on that value. When you cannot, make it manual: the user judges it on the card.",
    "Then run it with pie.script_run, start_pie: true and wait: true, and report the summary and results_path.",
  ].join("\n");
}
