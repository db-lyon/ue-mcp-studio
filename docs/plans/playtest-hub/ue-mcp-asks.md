# ue-mcp asks from the Playtest Hub

General features the Playtest Hub needs from ue-mcp, per the rule in CLAUDE.md: Studio does not patch around them. Each was checked against the sibling checkout at 1.4.16-beta.1 (`src/`, `plugin/ue_mcp_bridge`, `docs/pie-scripts.md`); none is there yet. The Studio side of each names its interim shape below.

## 1. A verdict on any ended run

**Problem.** `pie(verdict)` is refused for every run except the one the editor holds (`PieScriptVerdict`: "Run X is not the current run (Y)"). The held run takes a verdict after it ended and rewrites its `results.json`, but once another run starts, the earlier run's waiting manual steps can never be judged. A plan that defers manual steps starts its next check straight away, so only the last check's deferred steps can still be judged.

**Proposed API.** `pie(verdict, run_id, step, verdict, note?, source?, evidence?)` accepts an ended run that is not held by loading it from `<output_dir>/results.json`, applying the verdict to a step that is `awaiting_verdict`, recounting `summary`, and writing the file back. The answer is the same as today's, with `live: false`. A run with no `results.json`, or a step not awaiting, is refused as now. The `script.verdict` event fires with the run's id.

**Who benefits.** Any client that runs scripts unattended and collects verdicts later: CI followed by a morning review, an agent judging a batch, a person who answers a form after the next run began.

**Studio today.** `QaBroker.verdict` passes the refusal through. The inbox keeps the step and the check stays Needs you until the check runs again. (An earlier draft judged the step in a hidden manual run and copied the verdict onto the ended run's card; it was removed because ue-mcp's record and Studio's then disagreed.)

## 2. End a run once only verdicts remain

**Problem.** With `block_on_manual: false`, the bridge starts each manual step and moves on, but once every auto step has settled it keeps the run, and PIE, open until each manual step has a verdict (`AdvanceScriptRun` leaves the state `awaiting_verdict`; `IsScriptRunSettled` is false). A caller that wants to move on has to `script_stop` the run, which records `state: "stopped"` and a stop reason that reads like an interruption.

**Proposed API.** A `script_run` option, `manual_after: "hold" | "end"` (default `"hold"`, today's behaviour). With `"end"`, once no auto step is pending or running, the run finishes with `state: "finished"`, `stop_reason: "verdicts outstanding"`, its manual steps still `awaiting_verdict`, PIE stopped as at any finish, and `results.json` written. Ask 1 then takes those verdicts.

**Who benefits.** Every unattended caller: a CI flow, a batch of scripts, an agent queue. Each has to detect "only manual steps left" from the steps and stop the run itself today.

**Studio today.** `PlanQueue.evaluate` (`apps/agent/src/hub/queue.ts`) works out from the steps that only manual steps wait and calls `script_stop`. `outcomeOf` (`packages/shared/src/hub.ts`) judges a run by its steps rather than by how it ended, so a run stopped this way is Needs you while a step waits, and passes or fails once judged. A run stopped before its steps were reached is `stopped`, and health ignores it: it says nothing about the game.

## 3. Export the script run types

**Problem.** `ScriptEvent`, `ScriptStep` and the run states live in `dist/pie/script-events.d.ts` and are not exported from `ue-mcp/daemon`, so Studio keeps its own copies in `packages/shared/src/qa.ts`.

**Proposed API.** Re-export the types in `src/pie/script-events.ts` from `src/daemon-api.ts`, under `DAEMON_API_VERSION`.

**Who benefits.** Every extension or UI that follows `script.*` events.

**Studio today.** Its own `QaRun` and `QaStep` types, read defensively from the answers.
