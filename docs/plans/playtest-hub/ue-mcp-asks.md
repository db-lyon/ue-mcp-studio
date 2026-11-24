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

## From the design review

Asks 4 to 10 come from the [design review](review.md), numbered as there. Ask 5 is ask 1 above. Like the others, Studio checks for each by the fields and actions it finds, never by ue-mcp's version.

## 4. Run provenance in `results.json`

**Problem.** A run does not record what it tested. Two results for the same script may come from different script versions, different assets, a different level or player setup, or a throttled background editor. A client cannot tell a fix or a changed game from a flaky test. Only ue-mcp knows the script as run, the packages it reached and the environment PIE ran in.

**Proposed API.** A `provenance` object on `results.json`, on `script_runs` rows and on `script.run_started`. Each field is absent when unknown.

- `script_hash`: a hash of the script asset as run.
- `dependencies`: `{ "<package path>": "<saved package hash>" }` for the packages the script reaches: its map, its profile and the classes its steps name.
- `environment`:
  - `engine_version`: the full build string.
  - `map`: the level PIE actually played.
  - `net_mode` (`standalone`, `listen` or `client`), `clients` and `single_process`.
  - `dirty_packages`: packages unsaved in the editor when the run started.
  - `frame_ms` (`mean`, `worst`) and `background_throttled`.

**Who benefits.** CI, QA dashboards and agents: anything that compares runs or decides whether a result still holds.

**Studio today.** Studio records the source control revision and changed files itself when it sees a run start, and hashes the script's `script_read` definition. When `results.json` carries `script_hash`, `dependencies`, `engine_version`, `net_mode` and `clients`, Studio takes them over its own reading (`apps/agent/src/hub/provenance.ts`).

## 5. Pause on the frame a person-judged step starts waiting

This is ask 1.

## 6. A hold mode per step

**Problem.** Some manual steps ask a person to inspect a state, such as "the HUD shows 3 lives", where a paused frame is right. Others ask them to perform an action or watch motion, such as "jump the gap and confirm the landing feels right". One hold rule cannot serve both: pausing breaks the second kind, and a live hold lets the moment pass before anyone is watching.

**Proposed API.** A step field `hold: "pause" | "live"`, default `"pause"`. With `"live"`, the bridge holds before the step's `arrange` and `act` until a new `script_ready` call (`run_id`, `step`) says someone is watching, then plays the step live and waits for its verdict. `awaiting` entries and `script.awaiting_verdict` carry `hold` and whether the step is ready.

**Who benefits.** Any client that asks people to judge play: QA tools, agents handing a step to a person, remote judges.

**Studio today.** Every held step is paused.

## 7. Structured run end causes

**Problem.** Why a run ended is free text (`stop_reason`). A client has to match that text to tell a person's stop from a verdict timeout, PIE closing, a lost pawn or an editor crash, and each needs different handling: a timeout is no result, a crash is recorded once and never retried.

**Proposed API.** `end_cause` on `results.json`, `script_runs` and `script.run_finished`: `settled`, `stopped`, `verdict_timeout`, `pie_ended`, `observation_ended` or `editor_crash`. `stopped` adds `stopped_by` (`client` or `editor`). `stop_reason` stays as the readable text.

**Who benefits.** Plan runners, CI and anything that reports or retries runs.

**Studio today.** It compares `stop_reason` with the reason it passed itself (`QA_NO_VERDICT`) and reads every other outcome from the steps.

## 8. Typed refusal codes, and a verdict only while awaiting

**Problem.** Refusals are prose. Clients match text such as "already" or "is not the current run", which breaks when the wording changes. Two judges, such as a person on a phone and one at the editor, can each send a verdict, and the later one silently replaces the first.

**Proposed API.**

- Every `success: false` answer carries `code`, such as `not_active_run`, `already_stopped`, `step_not_awaiting`, `pie_running`, `map_unsaved` or `unknown_action`.
- `verdict` takes `if_awaiting: true`, which refuses with `step_not_awaiting` when the step already has its verdict.

**Who benefits.** Every client and agent that calls ue-mcp.

**Studio today.** It matches refusal text (`/already/i` when stopping a run, "unknown action" when asking for `script_runs`), and a second verdict replaces the first.

## 9. A stable script identity, and a script's dependencies without a run

**Problem.** Scripts are known by asset path, and Unreal renames assets freely. A moved script loses its history and breaks every reference to it. Separately, knowing whether a result is stale needs the script's current dependency fingerprints, which today exist only once a run records them (ask 4).

**Proposed API.**

- `script_list` and `script_read` return `id`, a persistent id stored on the script asset (or its package GUID), and resolve redirectors, saying `redirected_from` when they do.
- A new `script_dependencies` (`path` or `id`) returns `{ script_hash, dependencies }` as of now, hashed as in ask 4.

**Who benefits.** Any tool that tracks tests across renames, and CI that picks tests by what changed.

**Studio today.** Checks are keyed by path. A check is stale by age unless both its last pass and the workspace have fingerprints for the same packages, and the workspace has none until this exists.

## 10. PIE control scoped to a run

**Problem.** Pausing and stopping PIE act on whatever session is running, which may be the developer's own. A run may attach to a PIE session it did not start. Nothing says when someone else pauses or resumes PIE, so a client polls.

**Proposed API.**

- `script_run` takes `attach: false`, which refuses with `pie_running` when PIE is already running.
- `set_pie_paused` and stopping PIE take `run_id`, and refuse unless that run started the session (`pie_started`).
- New events `pie.paused` and `pie.resumed`, with `by` (`editor`, `client` or `run`).

**Who benefits.** Every client that shares an editor with a person.

**Studio today.** It pauses and stops only PIE sessions a run reports it started, and reads PIE's state by polling. The hub starts a run only when PIE is not running, so a run it starts always starts its own session; a person who presses Play in the moment between that check and the run's start would still be joined, which `attach: false` closes.

## 11. Editor occupancy in one query

**Problem.** A client that wants to use the editor without getting in a person's way has to piece together whether anything else holds it: PIE and who started it, an open modal dialog, an editor operation or build, another client's run and calls, and how long since someone used the editor. Each comes from a different place, some only as events since the client connected, and a run whose end event was missed (an editor crash) looks live for ever.

**Proposed API.** `editor(get_occupancy)` and an `editor.occupancy` event: `pie` (`running`, `started_by`: `editor`, `client` or `run`, with `run_id`), `dialog_open`, `operation` (`build`, `restart` and the like), `active_run` (`run_id`, `client`), `calls_in_flight` by client, `dirty_packages` count, and `input_age_ms` since the last user input in the editor.

**Who benefits.** Every automation client sharing an editor with a person: schedulers, CI runners, agents.

**Studio today.** It builds the answer itself (`hub/lease.ts` occupancyOf) from PieWatch, the dialog broker, the busy tracker, the runs it follows and the desktop's input age from Studio's window, and reads a live run again on each tick to find one the editor no longer knows.

## 12. Who dirtied a package, and a save scoped to a session

**Problem.** An agent fixing a playtest saves its changes, but the editor does not say which session or person dirtied a package. A client cannot tell the agent's unsaved changes from the person's, so a save can write a person's half-done work together with the agent's.

**Proposed API.**

- `editor(list_dirty_packages)` adds `dirtied_by` per package: `editor` (a person), or the `session_id` of the MCP session whose call dirtied it first.
- Save actions (`asset(save)`, `asset(save_all_dirty)`, `editor(save_dirty)`, `level(save)` and each action's `save: true`) take `only_mine: true`, which saves only packages the calling session dirtied and refuses with `code: "dirtied_by_other"` and the packages otherwise.

**Who benefits.** Any agent that edits a project while a person works in it.

**Studio today.** A fix loop reads the dirty packages before each attempt and treats them as the person's (`hub/write-lease.ts`), then refuses its own save calls that would write one of them. A package the loop itself left unsaved in an earlier attempt counts as the person's, and actions that save without a `save` flag are not seen.

## From the runner editor

Asks 13 and 14 come from [runner-editor.md](runner-editor.md), which has the research behind them.

## 13. Editor instances of one project

**Problem.** A client that runs work in the background, such as playtests, a CI pass or an agent exploring, has to share the developer's editor, because the daemon keeps one session per project root. `start_editor` refuses while the project's editor runs, and an editor started by hand takes over `port.json`, so the daemon would reconnect to it instead of the developer's editor. The bridge already moves a second editor to a free port and writes `instances/<pid>.json`, so the missing part is in the daemon.

**Proposed API.** Feature `editors.instances`.

- **Start and stop.** `editor(start_editor, instance: "<name>")` and `editor(stop_editor, instance: "<name>")`, taking start_editor's existing options (`window`, `ide`, `extraArgs`, `dialogPolicy`). For extensions: `api.instances.start(name, opts)`, `api.instances.stop(name)` and `api.instances.list()`. A start resolves once the instance's bridge answers, or with `{ ok: false, reason }`.
- **Listing.** `project(list_editors)` and `/v1/health` (`instances[]`) list each instance with its name, `connected`, `port`, `pid`, `window` and `readOnly`. `api.editors()` and `editors[]` keep listing only project sessions, so a client that knows one editor per project is unchanged.
- **Routing.** The existing `editor` argument names an instance, for MCP calls and `api.callAction` alike. An untargeted call never reaches an instance.
- **Addresses.** The daemon dials an instance by the pid it launched (its instance record). An instance writes no `port.json` and keeps its own status file and log (`-abslog`), which the engine observer reads for it.
- **Events.** An instance's lifecycle is `instance.connected` and `instance.disconnected` (`instance`, `cause`, `detail`), never `editor.*`. Every other event from an instance (`pie.*`, `dialog.*`, `script.*`, `call.*`) carries `instance: "<name>"`.
- **Shared state.** An instance does not write the developer's per-user settings on exit. A build, `editor/rebuild` or bridge update stops every instance first and says so, since running instances lock the project's modules. Instances stop when the daemon exits.

**Who benefits.** Any client that wants a background editor without taking the developer's: test runners, CI on a workstation, agents that explore or bake without touching the open level.

**Studio today.** `apps/agent/src/hub/runner.ts` uses `api.instances` behind this feature and ask 14. Without them, unattended plans run on the developer's editor under the hub's lease.

## 14. A read-only editor instance

**Problem.** A background editor that plays the game must never write the project: a save there would race the developer's own saves and check files out from source control behind their back. `callAction`'s `access: "read-only"` cannot hold such an editor. It refuses every action declared `mutate`, including `pie(script_run)`, and it scopes calls rather than the editor, so autosave and the save prompt on exit still write.

**Proposed API.** Feature `editors.readOnly`. `start_editor` (and `api.instances.start`) takes `readOnly: true`. Such an editor saves nothing to disk:

- every save action and `save: true` is refused with `code: "read_only_editor"`;
- autosave is off, and nothing is checked out from source control;
- on stop, dirty packages are discarded without a prompt.

Actions that change only the loaded world or play (PIE, test scripts, input, transient edits) still run. `list_editors` and `instances[]` report `readOnly`.

**Who benefits.** Test runners and CI, which must leave the working copy as they found it, and agents given an editor to experiment in.

**Studio today.** The runner editor asks for `readOnly: true` and will not start on a daemon without this feature: an offscreen editor that might save is the risk the runner exists to remove.
