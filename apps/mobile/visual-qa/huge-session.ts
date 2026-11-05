/**
 * A long session, as a months-old Studio session grows: user turns, replies
 * in markdown, many tool calls with long results, subagents, a compaction.
 * For the component test and the fake relay's long-session step.
 */
import type { SessionDetail, TranscriptEntry } from "@ue-mcp-studio/shared";

export const HUGE_ID = "huge-session";
export const HUGE_TITLE = "Long session";
/** The newest line of the session, which opening it must show. */
export const HUGE_LAST = "Everything is in place: the loop runs end to end.";

const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString();

/** About `bytes` of transcript as JSON. */
export function hugeTranscript(bytes = 8_000_000): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const result = "x".repeat(6000);
  let size = 0;
  let n = 0;
  const push = (e: TranscriptEntry) => {
    out.push(e);
    size += JSON.stringify(e).length;
  };
  while (size < bytes) {
    n++;
    push({ kind: "user", text: `Turn ${n}: tighten the caravan loop and rebuild.`, at: at(n * 100) });
    for (let k = 0; k < 6; k++) {
      push({ kind: "tool", call: { id: `t${n}-${k}`, name: k % 2 ? "read_file" : "shell", input: k % 2 ? { path: `Source/Loop/Part${k}.cpp` } : { command: `npx ue-mcp project build_project #${n}.${k}` }, outcome: "done", startedAt: at(n * 100 + k), endedAt: at(n * 100 + k + 1), result } } as TranscriptEntry);
    }
    if (n % 5 === 0) {
      push({ kind: "tool", call: { id: `a${n}`, name: "agent", input: { description: `Check part ${n}`, prompt: "Check it" }, outcome: "done", startedAt: at(n * 100 + 10), endedAt: at(n * 100 + 20), result: "Checked." } } as TranscriptEntry);
      push({ kind: "tool", call: { id: `a${n}-s`, name: "shell", input: { command: "git status" }, outcome: "done", startedAt: at(n * 100 + 11), endedAt: at(n * 100 + 12), result }, parent: `a${n}` } as TranscriptEntry);
    }
    push({ kind: "assistant", text: `## Turn ${n}\n\nRebuilt **${n}** parts.\n\n- one\n- two\n\n\`\`\`cpp\nint Part${n} = ${n};\n\`\`\``, at: at(n * 100 + 50) });
  }
  push({ kind: "user", text: "Is it done?", at: at(n * 100 + 90) });
  push({ kind: "assistant", text: HUGE_LAST, at: at(n * 100 + 95) });
  return out;
}

export function hugeSession(bytes?: number): SessionDetail {
  const transcript = hugeTranscript(bytes);
  return {
    id: HUGE_ID,
    title: HUGE_TITLE,
    status: "idle",
    createdAt: at(0),
    updatedAt: at(1_000_000),
    waitingCause: null,
    archived: false,
    agents: { total: transcript.filter((e) => e.kind === "tool" && e.call.name === "agent").length, running: 0 },
    awaiting: 0,
    draft: "",
    transcript,
  } as unknown as SessionDetail;
}
