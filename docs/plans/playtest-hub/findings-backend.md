# Playtest Hub findings: agent and shared types

Mapped 2026-11-22 against main at bfe3e21 (Studio 0.1.43, ue-mcp 1.4.11). Part of the [Playtest Hub plan](README.md).

**Summary.** The playtest unit is one ue-mcp PIE test script, identified by its asset path. Nothing in the agent or shared code models goals, suites, tags, priority, schedules or pass/fail trends. Run history is the newest run per script and nothing else.

## Shared types (`packages/shared/src`)

### `qa.ts`, the core model

- **States**
  - `QaStepStatus` (:9): pending, running, passed, failed, awaiting_verdict, skipped.
  - `QaRunState` (:11): draft, armed, running, awaiting_verdict, finished, stopped, idle. `draft` exists only in Studio.
  - `QaVerdict` (:12): pass, fail, skip.
  - `QaVerdictSource` (:14): auto, action, elicitation, agent, source_run.
- **`QaStep`** (:38):
  - Definition: `index`, `instruction`, `judge` (auto or manual), `expect{value, op, target, within_ms}`, `withinMs`.
  - Result: `status`, timings, `evidence` (observer values plus an agent's `note` and `captures[]`), `note`, `verdictSource`.
  - Studio-only: `agentJudgeable` and `player` (host or client n).
  - Replays: `sourceStatus` and `regression`.
  - `arrange`/`act` (ue-mcp#1507) and `actResult`.
- **`QaSummary`** (:75) holds counts: total, passed, failed, skipped, pending, awaiting, regressions.
- **`QaRun`** (:86):
  - Identity and progress: `runId`, `script` (asset path or "inline"), `scriptName`, `map`, `state`, `steps`, `awaiting[]`, `lastSeq`, `summary`.
  - Origin: `resultsPath`, `replayOf`, `sessionId|null`, `toolUseId`, `subagent`, `recordingId`.
  - Studio state: `assignment`, `deleted`, `manual`.
- **`QaAssignment`** (:125) and **`QaLoop`** (:179) model the Assign to subagent loop:
  - attempts with checkpoints before and after each one;
  - the changes made and the steps still failing;
  - a blocker (`QaBlocker` :147), one of nine kinds: verdict, no_progress, contradiction, refused, outside_project, needs_person, crashes, builds, attempts.
- **Drafts.** A draft card's id is `draft:<scriptKey>` (:524). `QaScriptStep` (:534) is the step shape `script_create`/`script_update` accept.
- **Merge logic** (:321-483) folds ue-mcp answers and stream events into a run. A settled step never goes back to an unsettled status (:290).

### `playtests.ts`

- `PlaytestEntry` (:32) holds `script`, `name`, `last`, `card`, `draft`, `session` and `deleted`.
- `PlaytestIndexAnswer` (:53) is `{playtests, listed, more}`.
- The predicates `qaNeedsYou`, `qaActive` and `qaFailing` (:10-29) look only at the newest run.
- Filters: active, needs-you, failing, all.
- Sort order: needs-you, then live, then newest, then name.

### Other shared types

- `commands.ts`:
  - the `/playtest` slash command, which also works typed mid-message;
  - `PlaytestStage`: gathering, drafting, checking, created;
  - `PlaytestRequest {text, source, turn}`.
- `flows.ts`: `/flow` types and builders that make a form from a flow's plan.
- `index.ts`:
  - transcript entries `qa`, `playtest` and `flow`, plus the legacy `playtest-failed`;
  - `TurnFacts.playtest`;
  - `PlaytestRunsMode` (manual or automatic, :950-962).
- `agents.ts`: `SessionDerived.liveRuns`.
- `notifications.ts`: `playtest.needs-you` and `playtest.finished`.

## Agent modules (`apps/agent/src`)

| Module | Role |
|---|---|
| `playtest-store.ts` | `<dataDir>/playtests.json`: the runs setting (manual or automatic) and per-step players. Nothing else. |
| `sessions.ts` | `<dataDir>/sessions/<id>.json`. Runs owned by Studio live **inside session transcripts** as `qa` entries. |
| `qa.ts` (`QaBroker`) | The hub, described below. |
| `playtest-index.ts` | The project-wide Playtests page, merged from three sources, described below. |
| `playtest-brief.ts` | The prompt for an assigned subagent: how to run, configure multiplayer PIE, inject input or replay a recording, and judge manual steps with `capture_screenshot` + `pie.verdict source:"agent"`. |
| `playtest-loop.ts` | The Assign loop, described below. |
| `playtest-flow.ts` | `/playtest` calls `POST /v1/flows/playtest/run` with tasks gather, draft, check and save. The target is the first asset path found in the message or conversation. Context is capped at 12k characters. |
| `flow-run.ts` | Generic `/flow` (`GET /v1/flows/<n>/plan`, `POST .../run`) with optional per-step approval. |
| `flow-model.ts` | Registers Studio's selected model with the daemon so flow agent steps run on it. |
| `runner.ts` | System-prompt QA rules (:78-92), `qa.wrap` on every tool host (:631), `/playtest` routing (:1522, :1653), `assignSubagent` (:2844). |
| `durable/pi.ts` | An assigned child keeps running after the main agent stops and reports only to the daemon. |
| `viewport/pie-watch.ts` | Tracks whether PIE runs. Counts `script_run`, `script_replay`, `replay_run` and `uat_run` as starting PIE. `uat_*` appears nowhere else in Studio. |
| `notify.ts`, `quick.ts`, `agent-settings.ts` | Notices, the quick-ask count of awaiting verdicts, and the `playtestRuns` setting. |

### The `QaBroker` (`qa.ts`)

- **Run map.** It keeps runs in memory and rebuilds them from session transcripts at startup.
- **Events.** It subscribes to daemon `script.*` events and to `editor.connected`, and discovers runs it has not seen yet.
- **`wrap()` (:240) intercepts a session's `callAction`:**
  - `pie.script_create`/`script_update` become a draft card;
  - `script_delete` marks every card of that script deleted;
  - `script_run`/`script_replay` are refused under Manual unless the caller is an assigned subagent.
- **`save()` (:809)** applies players, auto-passes a loop once every step passes, and swaps a card in place for the new run. It publishes `studio.qa.changed` and transcript events.

### The Playtests index (`playtest-index.ts`)

It merges three sources:

- the editor's `pie.script_list` (15 s cache);
- the broker's runs;
- ue-mcp's `pie.script_runs`. When that action is missing it backs off for 5 minutes and falls back to `Saved/MCPObservations/*/results.json` (at most 300, cached by mtime).

Scripts that never ran are read with `script_read` (at most 60 per page). `card()` creates a session titled "Playtest X" when no session has a card for the script.

### The Assign loop (`playtest-loop.ts`)

- **Attempts.** Each attempt is an assigned subagent, bracketed by checkpoints. Attempt 1 runs and reports; later attempts fix first.
- **Blockers.**
  - no progress, detected by failure signatures;
  - a `BLOCKED: <kind>:` line in the subagent's report;
  - refusals and writes outside the project;
  - two crashes or two failed builds in a row;
  - 8 attempts.
- **Carry-over.** A loop that stopped needing a person can be continued by a new loop.

## Lifecycle of a playtest

1. **Create.** The agent's `pie.script_create` (intercepted into a draft card), `/playtest` (the flow, then `qa.drafted`), or the Make playtest pill.
2. **Edit or delete.** From the card or the Playtests page, through `script_update`/`script_delete`. Players go to `playtests.json`.
3. **Run.**
   - Start playtest: optional `configure_pie`, then `script_run`.
   - The agent's own `script_run`, allowed only under Automatic.
   - A verdict on a draft's manual step starts a manual run without PIE.
   - Assign starts the loop.
4. **Progress.** `script.*` stream events plus `script_status since_seq`. Every change is written into the session file.
5. **Verdict.**
   - A person: `POST /qa/runs/:id/verdict`. A fail needs a note.
   - An assigned subagent: `pie.verdict source:"agent"`. A person's later verdict clears the agent's evidence.
6. **End.** `run_finished`. Results live in ue-mcp's `Saved/MCPObservations/<run>/results.json`. Captures are served only from under `<project>/Saved`.

## HTTP routes (under `/v1/ext/studio`)

| Method | Path | Purpose |
|---|---|---|
| GET | /qa/runs | Runs started outside Studio, not dismissed |
| GET | /qa/runs/:id/status `?since_seq` | `{answer, run}` |
| POST | /qa/runs/:id/verdict `{step, verdict, note}` | A person's verdict |
| GET | /qa/runs/:id/results | The run's results.json |
| GET | /qa/runs/:id/steps/:step/captures/:n | Capture image |
| POST/DELETE | /qa/runs/:id/assign | Start or cancel the Assign loop |
| POST | /qa/runs/:id/loop/revert `{attempt}` | Revert loop attempts |
| POST | /qa/runs/:id/stop | Stop a run |
| POST | /qa/runs/:id/run `{startPie, players, listen, record}` | Start a run |
| PUT/DELETE | /qa/runs/:id/script | Edit or delete the run's script |
| DELETE | /qa/runs/:id | Dismiss |
| GET | /qa/playtests `?fresh=1&limit=` | `PlaytestIndexAnswer` |
| POST | /qa/playtests/card `{script}` | Find or create the script's chat card |
| GET/PUT/DELETE | /qa/playtests/script | Read, write or delete a script by path |
| POST | /sessions/:id/playtest | `/playtest` from a client |
| POST | /sessions/:id/flow | `/flow` from a client |
| GET/PUT | /agent-settings | Includes `playtestRuns` |

Sources: `qa.ts:867-920`, `playtest-index.ts:407-429`, `chat-routes.ts:828-853`.

## Relation to ue-mcp

- **Imports.** From `ue-mcp/daemon`: the types `ActionResult` and `DaemonExtensionApi`, plus `readDiscovery`.
- **`pie` actions used:** `script_create`, `script_update`, `script_read`, `script_delete`, `script_list`, `script_runs`, `script_run`, `script_replay`, `script_status`, `script_results`, `script_stop`, `verdict`.
- **`editor` actions used:** `configure_pie`, `show_notification`.
- **Raw daemon HTTP:** `/v1/flows/playtest/run`, `/v1/flows/<n>/run`, `/v1/flows/<n>/plan`.
- **Extension APIs:** `models.register`, `flows.approveSteps`, `actions.effects`, `checkpoints`.
- **Ownership.** ue-mcp owns scripts, runs, the observer, verdicts, recordings and results.json. Studio adds drafts, players, sessions, assignments and loops on top.

## Gaps and seams

- **No grouping or history model.** There are no goals, suites or tags, and no per-script history or trend endpoint. Older runs exist only in ue-mcp and scattered session transcripts.
- **Runs are not durable on their own.**
  - Studio's runs live inside session JSON.
  - Runs started outside Studio, and the dismissed set, are held only in memory and are lost on restart.
- **Cards are taken over in place.** One card is successively a draft, a manual run, a full run and loop attempts. The logic is intricate; its comments cite bugs #139 and #143.
- **Loops do not survive a daemon restart.** A loop running at a restart is marked stopped and cannot resume.
- **Flow events are matched by guesswork:** the first `run_started` for the flow's name. A concurrent run from another client could be taken for ours.
- **Acceptance and inline runs are left out.**
  - `script === "inline"` runs are excluded from the index.
  - `uat_run`/`replay_run` are tracked only by pie-watch.
  - Nothing orchestrates more than one script at a time.
- **Housekeeping.**
  - `playtestRuns` sits in `AgentSettings`, documented as settings ue-mcp owns, yet is stored by Studio.
  - JSDoc is doubled at `qa.ts:425` and `qa.ts:724`.
  - A pinning note at `playtest-index.ts:133` looks outdated.
- **Tests:** `apps/agent/test/{qa,qa-model,qa-prompt,playtest-assign,playtest-drafts,playtest-flow,playtest-index,playtest-loop,playtest-runs-setting,flow-run,flow-model}.test.ts`.
