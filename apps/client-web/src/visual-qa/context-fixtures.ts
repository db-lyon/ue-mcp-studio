/**
 * The context meter and compaction markers for the visual QA harness: the
 * meter low, high and near full, after a switch to a model with a smaller
 * window, an older session with only an estimate, its details opened, and a
 * compaction marker collapsed, opened, running, failed and in a subagent's
 * thread.
 */
import type { ContextUsage, SessionDetail, SessionSpend, StudioSettings, TranscriptEntry } from "@ue-mcp-studio/shared";
import type { Scenario } from "./fixtures";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const SESSION_ID = "qa-session";

const SUMMARY = [
  "**Asked for:** a weathered wooden door for the cave entrance that swings open when the player walks into its trigger, with a creak sound and no visible pop.",
  "",
  "**Done so far:**",
  "- `BP_Door` (`/Game/Props/Doors/BP_Door`): a Timeline `DoorSwing` (0.9 s, ease out) drives the hinge's relative yaw from 0 to 95.",
  "- `M_DoorWood_Weathered` made from `M_WoodMaster`, roughness 0.78, moss mask on.",
  "- `SC_DoorCreak` sound cue wired to the timeline's start.",
  "- The pop was the hinge pivot at the door's centre; the mesh pivot moved to the left edge in `SM_Door`.",
  "",
  "**Open:** the trigger box overlaps the wall, so it fires early from the corridor. Next step: shrink `TriggerBox` X extent to 60 and test with the playtest `PT_DoorOpens`.",
].join("\n");

const talk: TranscriptEntry[] = [
  { kind: "user", text: "Make the cave door swing open when I walk up to it, with a creak, and fix that pop.", at: ago(48) },
  { kind: "assistant", text: "The pop came from the hinge pivot sitting at the door's centre. I moved it to the left edge and added a 0.9 second timeline with an ease out.", at: ago(46) },
  { kind: "user", text: "Better. Weather the wood a bit too.", at: ago(40) },
  { kind: "assistant", text: "Done: `M_DoorWood_Weathered` with more roughness and the moss mask on.", at: ago(38) },
];

const after: TranscriptEntry[] = [
  { kind: "user", text: "The trigger fires from the corridor. Can you tighten it?", at: ago(4) },
  { kind: "assistant", text: "I shrank the trigger box to 60 units deep so it no longer reaches through the wall. Walk up to the door to try it.", at: ago(2) },
];

const compacted = (over: Partial<Extract<TranscriptEntry, { kind: "compaction" }>> = {}): TranscriptEntry =>
  ({ kind: "compaction", at: ago(20), trigger: "auto", state: "done", before: 852_300, after: 21_400, summary: SUMMARY, method: "summary", model: "Sonnet 5.5", ms: 23_000, ...over } as TranscriptEntry);

const TOTALS: SessionSpend = { input: 412_000, cacheRead: 18_400_000, cacheWrite: 690_000, output: 96_300, reasoning: 41_200, requests: 214, costUsd: 12.37 };

function session(transcript: TranscriptEntry[], context: Record<string, ContextUsage>, totals: SessionSpend | null = TOTALS, over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: SESSION_ID, title: "Cave door", status: "idle", createdAt: ago(60), updatedAt: ago(1), waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0,
    transcript, touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [], review: null, timeline: [],
    tokens: { main: totals?.input ?? 0 }, context, ...(totals ? { totals } : {}), ...over,
  };
}

const main = (input: number, model = "claude-sonnet-5-5", over: Partial<ContextUsage> = {}): Record<string, ContextUsage> =>
  ({ main: { input, cached: Math.round(input * 0.9), output: 2_400, model, at: ago(1), ...over } });

/** On a key: Studio compacts the conversation itself, at 85%. */
const KEY: Partial<StudioSettings> = { route: "key" };

const scene = (title: string, s: SessionDetail, extra: Partial<Scenario> = {}): Scenario =>
  ({ title, hash: `#/chat/${SESSION_ID}`, session: s, index: { playtests: [], listed: true }, settings: KEY, ...extra });

const thread = (): SessionDetail => {
  const call: TranscriptEntry = { kind: "tool", call: { id: "agent-cave", name: "agent", input: { description: "Dress the cave floor", prompt: "Place rocks and debris along the cave floor, avoiding the door's swing." }, outcome: "pending", startedAt: ago(30) } };
  const step = (id: string, method: string, minutes: number): TranscriptEntry =>
    ({ kind: "tool", call: { id, name: "ue_mcp", input: { action: "call", category: "level", method }, outcome: "done", startedAt: ago(minutes), endedAt: ago(minutes), result: "{}" }, parent: "agent-cave" });
  return session(
    [
      { kind: "user", text: "Dress the cave floor with rocks while you look at the door.", at: ago(31) },
      call,
      step("s1", "spawn_actor", 28),
      step("s2", "spawn_actor", 26),
      compacted({ parent: "agent-cave", before: 171_000, after: 9_800, at: ago(12), model: "Haiku 5.5", ms: 8_000 } as never),
      step("s3", "spawn_actor", 10),
      { kind: "assistant", text: "Placed 14 more rocks along the east wall, clear of the door.", at: ago(9), parent: "agent-cave" },
    ],
    { ...main(64_000), "agent-cave": { input: 15_200, cached: 12_000, output: 900, model: "claude-haiku-5-5", at: ago(9) } },
    TOTALS,
    { status: "running", agents: { total: 1, running: 1 }, tokens: { main: 210_000, "agent-cave": 188_000 } },
  );
};

export const CONTEXT_SCENARIOS: Record<string, Scenario> = {
  "context-low": scene("Context meter low: 8% of a 1M window, green bar, the tick where Studio compacts", session([...talk, ...after], main(82_000))),
  "context-high": scene("Context meter high: 70% of the window, amber", session([...talk, ...after], main(698_000))),
  "context-near-full": scene("Context meter near full: 83%, red, with the warning and Compact now above the composer", session([...talk, ...after], main(828_000))),
  "context-details": scene("Context meter opened: tokens of the window, the last request, where it compacts, and the session totals with cost", session([...talk, ...after], main(698_000)), { clicks: [".context-button"] }),
  "context-model-switch": scene(
    "After switching to Haiku 4.5 (200k window) from Sonnet 5.5: the same 310k context is now over the window, red, and the details say where it was measured",
    session([...talk, ...after], main(310_000)),
    { settings: { ...KEY, model: "claude-haiku-4-5" }, clicks: [".context-button"] },
  ),
  "context-over-window": scene(
    "After switching to Haiku 4.5 with 310k in context, the details closed: the bar marks the overflow and the warning says Studio compacts before the next request",
    session([...talk, ...after], main(310_000)),
    { settings: { ...KEY, model: "claude-haiku-4-5" } },
  ),
  "context-estimated": scene("A session from before Studio measured context: an estimate, marked with ~, and no totals", session([...talk, ...after], main(41_000, "", { cached: 0, output: 0, estimated: true }), null), { clicks: [".context-button"] }),
  "context-claude-runtime": scene(
    "On the Claude sign-in: the window and compaction point Claude's runtime reported",
    session([...talk, ...after], main(150_400, "claude-sonnet-5-5", { window: 1_000_000, compactAt: 967_000 })),
    { settings: { route: "claude" }, clicks: [".context-button"] },
  ),
  "compaction-collapsed": scene("A compaction marker in the transcript: before and after tokens, automatic, its time", session([...talk, compacted(), ...after], main(31_000))),
  "compaction-expanded": scene("The compaction marker opened: who summarised it, how long it took, and the summary the agent works from", session([...talk, compacted({ trigger: "manual", instructions: "the door's exact asset paths" }), ...after], main(31_000)), { clicks: [".compaction-line"] }),
  "compaction-running": scene("Compacting now: the marker pulses, the meter says Compacting", session([...talk, compacted({ state: "running", before: 864_400, after: undefined, summary: undefined, ms: undefined, at: ago(0) })], main(862_000), TOTALS, { status: "running" })),
  "compaction-failed": scene("A compaction that failed, opened: why, and that nothing was cut", session([...talk, compacted({ state: "failed", before: 814_400, after: undefined, summary: undefined, error: "Anthropic: overloaded, try again in a minute." }), ...after], main(812_000)), { clicks: [".compaction-line"] }),
  "compaction-subagent": scene("A subagent's own thread, compacted on its own: the marker in its thread", thread(), { clicks: [".agent-link"] }),
};
