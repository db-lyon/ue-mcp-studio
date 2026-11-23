# ue-mcp asks from the Playtest Hub

General features the Playtest Hub needs from ue-mcp, per the rule in CLAUDE.md: Studio does not patch around them. Each was checked against the sibling checkout at 1.4.16-beta.1 (`src/`, `plugin/ue_mcp_bridge`, `docs/pie-scripts.md`); none is there yet. The Studio side of each names its interim shape below.

Two earlier asks, a verdict on any ended run and ending a run once only verdicts remain, existed only for deferred verdicts. Decision 12 in the [plan](README.md) removed deferral, so they are withdrawn.

## 1. Pause PIE on the frame a manual step starts waiting

**Problem.** A manual verdict means a person watched the step happen, so the game must not run on while the run waits for them. With `block_on_manual` (the default) the bridge holds the run at a manual step, but PIE keeps simulating. A client can pause it with `editor(set_pie_paused)` only once it hears `awaiting_verdict`, a round trip later: the step's `act` has played and some frames have passed, so the person sees the moment after the one they are asked to judge.

**Proposed API.** A `script_run` option, `pause_on_manual: boolean` (default false). With it, the bridge pauses PIE with the editor's own Pause (as `set_pie_paused` with `mode: "debug"` does) on the frame a step a person judges (`judge: "manual"` and `agent_judgeable: false`, or any manual step when no agent will judge it) starts waiting, before its act's effects advance, and resumes PIE when the step gets its verdict. The run's status and `script.awaiting_verdict` event carry `paused: true` while it holds. A resume the client asks for in between (`set_pie_paused` false) is the person's choice and is left alone.

**Who benefits.** Every client that asks a person to judge a running game: a QA tool, a CI flow with someone on call, an agent that hands a step to a person.

**Studio today.** `apps/agent/src/verdict-hold.ts` pauses PIE from the agent when a run's step starts waiting for a person, and resumes it on the verdict. The comment there names it interim. Once ue-mcp ships `pause_on_manual`, Studio passes it and keeps the agent's pause only as a fallback for an older ue-mcp, chosen by feature check.

## 2. Export the script run types

**Problem.** `ScriptEvent`, `ScriptStep` and the run states live in `dist/pie/script-events.d.ts` and are not exported from `ue-mcp/daemon`, so Studio keeps its own copies in `packages/shared/src/qa.ts`.

**Proposed API.** Re-export the types in `src/pie/script-events.ts` from `src/daemon-api.ts`, under `DAEMON_API_VERSION`.

**Who benefits.** Every extension or UI that follows `script.*` events.

**Studio today.** Its own `QaRun` and `QaStep` types, read defensively from the answers.
