/**
 * What a subagent the user assigns a playtest to is told: the run, its steps,
 * how to drive PIE so the auto steps evaluate, and how to judge the manual
 * steps it may judge from frames, with evidence.
 */
import { qaAgentMayJudge, qaEnded, qaSettled, type QaRun, type QaStep } from "@ue-mcp-studio/shared";

/** The thread's title in the chat. */
export const playtestDescription = (run: QaRun): string => `Playtest ${run.scriptName}`;

function stepLine(s: QaStep): string {
  const who = s.judge === "auto" ? "auto" : qaAgentMayJudge(s) ? "manual, you judge it" : "manual, the user judges it";
  const expect = s.expect ? ` Expect ${s.expect.value} ${s.expect.op}${s.expect.target !== undefined ? ` ${s.expect.target}` : ""}${s.withinMs ? ` within ${s.withinMs} ms` : ""}.` : "";
  const note = s.note ? ` Note: ${s.note}` : "";
  return `${s.index}. [${who}] ${s.instruction}.${expect} Status: ${s.status}${s.verdictSource ? ` (by ${s.verdictSource})` : ""}.${note}`;
}

export function playtestBrief(run: QaRun): string {
  const live = !qaEnded(run.state);
  const inline = run.script === "inline";
  const again = inline
    ? "pie.script_run with the same steps inline (read them with pie.script_results for this run)"
    : `pie.script_run with script "${run.script}"`;
  const manual = run.steps.filter((s) => s.judge === "manual");
  const mine = manual.filter(qaAgentMayJudge);
  const theirs = manual.filter((s) => !qaAgentMayJudge(s));
  const open = run.steps.filter((s) => !qaSettled(s.status) || (s.judge === "auto" && s.status === "failed"));
  return [
    `The user assigned you the playtest "${run.scriptName}" from its Playtest card. Run it in Play In Editor on their behalf so its steps get verdicts.`,
    `Run ${run.runId}, script ${run.script}, state ${run.state}. Step indices are 0-based, as pie.verdict takes them:`,
    ...run.steps.map(stepLine),
    "",
    "How to work:",
    live
      ? `- The run is still going: work on it. Follow it with pie.script_status (run_id ${run.runId}, since_seq the last_seq you read).`
      : `- The run has ended${open.length ? ` with ${open.length} step${open.length === 1 ? "" : "s"} not passed` : ""}. Run it again with ${again}, start_pie: true and wait: false, then work on the new run_id it answers with. Never pass wait: true: you have to drive the pawn while it runs.`,
    "- If PIE is not running when you need it, start the run with start_pie: true. Do not stop PIE while a step is waiting for the user.",
    run.recordingId
      ? `- Drive the pawn so the auto steps can pass. A run of this script recorded its input as recording ${run.recordingId}: once PIE is up, replay it with pie.replay_arm (recording_id ${run.recordingId}). If the replay does not reach a step, drive the rest with pie.inject_input, pie.inject_input_start, pie.inject_input_update, pie.inject_input_stop and pie.inject_input_tape.`
      : "- Drive the pawn so the auto steps can pass: pie.inject_input for one frame, pie.inject_input_start, pie.inject_input_update and pie.inject_input_stop for a hold, pie.inject_input_tape for a run of values. Find the project's Enhanced Input actions with ue_mcp search first. Describe each action before its first call.",
    mine.length
      ? `- For each manual step you judge (${mine.map((s) => s.index).join(", ")}), once it is awaiting a verdict: capture frames of the PIE viewport with editor.capture_screenshot (target "pie"), look at them, and decide pass or fail; skip only when the step cannot be reached. Then call pie.verdict with run_id, step, verdict, source: "agent" and evidence: { note, captures }, where note says what you saw in the frames (it must not be empty) and captures are the capture file paths. Describe pie.verdict before its first call.`
      : "- No manual step is yours to judge.",
    theirs.length
      ? `- Steps ${theirs.map((s) => s.index).join(", ")} are the user's to judge: never give them a verdict. Leave them awaiting.`
      : "- Never give a verdict on an auto step: the observer decides those.",
    "- Give each verdict as soon as you have judged the step: the user watches the card fill in.",
    "Finish with a short report: each step's outcome, the run_id and results_path, and the steps you left for the user.",
  ].join("\n");
}
