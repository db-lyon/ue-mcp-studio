# Playtest Hub findings: what ue-mcp offers

Mapped 2026-11-22 from the sibling checkout `C:\Users\David\Projects\UE\ue-mcp` (1.4.16-beta.1) and the installed package (1.4.11, the version Studio pins). Part of the [Playtest Hub plan](README.md).

Studio may use ue-mcp only through `ue-mcp/daemon` and the daemon's HTTP API (see CLAUDE.md).

## Two things called "playtest"

- **Test scripts** are the real engine. The bridge's `pie(script_*)` actions implement them, and `docs/pie-scripts.md` specifies them.
- **The `playtest` flow** (`src/flow/playtest/index.ts`) only drafts a script with a model:
  - gather (Blueprint, input mapping contexts, script values);
  - draft, then validate, with up to 2 retries;
  - save as `TS_Playtest_<leaf>`.

  It needs a model from `api.models.register` or `ANTHROPIC_API_KEY`.

## Test scripts

- **Storage.** UE data assets, by default under `/Game/PIEStudio/Scripts`.
- **Asset fields:** `steps`, `description`, `profile`, `map`, `default_within_ms` (5000), `manual_only`.
- **Step fields:** `instruction`, `judge` (auto or manual), `agent_judgeable`, `resolve_in_pie`, `arrange[]`, `act[]`, and `expect {value, op, target, within_ms, client}`.
  - `arrange`: spawn, set, call.
  - `act`: place, press, inject, hold, tape, console, capture, key, wait_ms.
- **Ops:** decreasing, increasing, eq, gt, lt, visible, exists, triggered. `triggered` is not in 1.4.11.
- **Actions:**
  - CRUD: `script_create`, `script_read`, `script_update`, `script_delete`, `script_list` (includes `last_run`), `script_validate`, `script_values`.
  - Lifecycle: `script_run`, `script_status`, `script_stop`, `verdict`, `script_results`, `script_runs`, `script_replay`.

## How a run works

- **`script_run` parameters:**
  - a stored `script` or inline `steps`;
  - `map`, which refuses if the open level has unsaved changes;
  - `start_pie`, `record` (default true), `block_on_manual`;
  - `mode` (full, or manual without PIE);
  - `pie_instance`, `client_id`, `wait`, `timeout_seconds` (600).
- **One run at a time per editor.** This shapes any orchestrator: runs on one editor are a queue, never parallel.
- **Auto steps** are checked every observed frame. A step passes on the first frame its condition holds and fails after `within_ms` of game time.
- **Manual steps** go to a person through an elicitation form, or are settled with `verdict`. An agent verdict needs `evidence {note, captures}`, and `agent_judgeable: false` blocks agents.
- **End reasons:** every step settled, PIE ended, observation ended, no pawn within 10/30 s, or `script_stop`.
- **Run id:** `script_<name>_<YYYYMMDD_HHMMSS>`.
- **Artifacts:**
  - `<Project>/Saved/MCPObservations/<run_id>/`: `results.json` (with summary and per-step evidence), `manifest.json`, `observation.csv`, `tracked.jsonl`, `captures/`.
  - `<Project>/Saved/MCPRecordings/<run_id>/`: `sequence.json`, `recording.csv`, and on replay `drift.json`, `replay.csv`, `frames/`, `captures/`.
- **History.** `script_runs(script?, limit?)` lists the active run and then every `results.json` on disk, newest first. There is no database.
- **Regression.** `script_replay` replays recorded input and checks auto steps again, flagging `regression` per step and in the summary.
- **Playtest mode** (manual or automatic, per project or user) gates only MCP sessions. **`api.callAction` is never gated**, so Studio enforces its own rule.

## Other automation in ue-mcp

- **Record, replay, observe:**
  - `record_*` and `replay_*`, including the unattended `replay_run`;
  - `replay_analyze`, `record_diff`, `perf_summary`;
  - observation profiles: `profile_*`, `observe_*`.
- **Reproduction tests:**
  - `test_scaffold` writes `test.json` beside a recording;
  - `test_run` checks drift, errors and predicates (always, never, eventually, at_end, once_then_always);
  - `test_list`, `assert_eval`, `scenario_scaffold`, `scenario_validate`.
- **Multiplayer acceptance (UAT):**
  - `uat_run(scenario | path)` opens the map, starts multi-client PIE and judges steps by regex rules on host and client logs. It writes `report.md` and `report.json`.
  - `uat_status`, `uat_abort`; `pie.windowless` runs clients offscreen.
- **Unreal Automation framework:** `editor(run_automation_tests, filter, maxTests, latentTimeoutSeconds)` returns pass/fail per test. Tests that start PIE are reported as abandoned.
- **Input:** `inject_input*`, `send_key`, `drive_pawn`, `console`.
- **Diagnostics:** `session_errors` and `session_log` (from `Saved/MCPSessions/`), `anim_state`, `view_trace`.
- **Screenshots:** `editor(capture_screenshot target=pie|editor|window)` and `capture_screenshot_sequence`.
- **Headless:** an offscreen editor (`-RenderOffScreen`) and `launch_standalone` (`-game`).
- **Not present:** Gauntlet, Functional Tests, CI reporting formats. The closest is `npx ue-mcp flow run <name> --json`, which exits 1 on failure.

## Daemon surface relevant to a hub

- **No playtest, PIE or automation HTTP routes.** Actions are reached through `api.callAction("pie", ...)` or `WS /v1/mcp`.
- **Events** (on `GET /v1/events`, SSE, resumable):
  - `script.run_started`, `script.step_started`, `script.step_acted`, `script.step_passed`, `script.step_failed`, `script.verdict_requested`, `script.verdict`, `script.run_finished`.
  - They cover only runs the server follows, and are de-duplicated on (`runId`, `seq`).
  - Flows publish `flow.run_*` and `flow.step_*`.
- **Flows:** `GET /v1/flows`, `GET .../<name>/plan`, `POST .../<name>/run`. The run call answers only when the run ends, and there is no run history.
- **Extension API:**
  - running and events: `callAction` (with `signal`), `events.publish`, `events.subscribe`, `events.since`;
  - `route`;
  - **`dataDir`**: per-project extension state outside the project tree;
  - `modes`, `models.register`;
  - `flows.approveSteps` (not in 1.4.11);
  - `editorOperation`, `setBusy`.
- **Typing gap.** `ScriptEvent`/`ScriptStep` types exist in `dist/pie/script-events.d.ts` but are not exported from `ue-mcp/daemon`.

## What does not exist anywhere

- Tags, suites, goals or schedules.
- Aggregated history.
- Playtest or QA guidance in `skills/`.

All of these would be Studio's own data, kept in `api.dataDir` or in the project. A general ue-mcp feature is the alternative where other clients would benefit too, per the rule about ue-mcp in CLAUDE.md.
