# Playtest Hub

Status: draft plan, 2026-11-22. Branch `feat/playtest-hub`. Experimental: ships behind a setting, off by default.

The Playtest Hub is the place in Studio where a team says what the game must do, sees whether it does, and puts agents to work on the gap. It manages goals, the playtests and other checks that prove them, the runs that produce evidence, and the queue that schedules those runs on the editor.

## Findings

- [Agent and shared types](findings-backend.md)
- [Web and mobile clients](findings-client.md)
- [What ue-mcp offers](findings-ue-mcp.md)

**What exists today:**

- A complete playtest card: steps, verdicts, agent captures, the Assign to subagent fix loop with checkpoints and reverts, and a draft editor.
- A project-wide Playtests page on both clients, hidden since 2026-10-26.
- ue-mcp test scripts with auto and manual steps, recordings, replay regression checks and `results.json` per run.

**What is missing:**

- Anything above a single script: goals, suites, tags.
- Run history beyond the newest run per script.
- Orchestration of more than one run.
- Evidence beyond agent captures.
- Durable state for loops and for runs started outside Studio.
- Creating a playtest without going through chat.

## Concepts

| Concept | Meaning | Owner |
|---|---|---|
| **Goal** | An outcome the game must meet, such as "A new player finishes the tutorial" or "Four players join a listen server". It has a status, optional acceptance rules and a set of checks. Goals can nest one level, as milestone and goal. | Studio (new) |
| **Check** | One thing a goal is proven by. Kinds: test script (exists), UAT scenario, reproduction test, Unreal automation filter, and a manual checklist item a person signs off. The first slice covers test scripts only. | ue-mcp runs it; Studio links it |
| **Run** | One execution of a check, with its verdicts and evidence. | ue-mcp (`results.json`); Studio indexes it |
| **Plan run** | A batch of checks run in order on one editor, for example "run the goal", "run everything failing" or "nightly". | Studio (new) |
| **Queue** | The ordered plan runs and single runs waiting for the editor. One run at a time per editor (ue-mcp rule). | Studio (new) |
| **Inbox** | Everything that needs a person: verdicts waiting, loops blocked, goals that regressed. | Studio (derived) |

### Goal status

A goal's status is computed from its checks' latest runs and its acceptance rules. Nobody sets it by hand.

| Status | Rule |
|---|---|
| **Met** | Every required check passed on its latest run, any sign-off is given, and the stability rule holds. The default stability rule is the last run; it can be raised to "last N runs". |
| **At risk** | Met, but a check is flaky (mixed results within its last N runs) or stale (not run since a change to its assets, or older than a set age). |
| **Failing** | A required check failed on its latest run. |
| **Needs you** | A verdict or sign-off is waiting. |
| **Not started** | No checks yet, or none has run. |

## The experience

### Navigation

The Playtests tab returns as **Playtests** when the experimental setting is on. It has its own left rail on wide screens, and a segmented header with the drawer when narrow. Routes stay hash-based:

| Route | Screen |
|---|---|
| `#/playtests` | **Overview**: goals with status, the inbox count, the queue strip, recent regressions. |
| `#/playtests/inbox` | **Inbox**: verdicts, blocked loops and regressions, oldest first, settled one by one from the keyboard. |
| `#/playtests/goals/<id>` | **Goal**: its checks with health and history sparklines, its acceptance rules, Run goal, and Write playtests for this goal. |
| `#/playtests/checks` | **Library**: every script and other check, filterable by goal, status, tag, map and author, with bulk select. Grows from today's hidden page. |
| `#/playtests/checks/<script>` | **Check**: definition, history (every run, newest first), flakiness, edit. |
| `#/playtests/runs/<runId>` | **Run**: the timeline described under Evidence below. |
| `#/playtests/queue` | **Queue**: what runs now, what is next, reorder, pause, plus schedules. |

### Interaction standards

- **The status ladder is the same everywhere.** Needs you sorts above Failing, Failing above At risk, then Running, Met and Not started. The same colours and glyphs appear in pills, sparklines and the tab badge.
- **Keyboard first on wide screens:**
  - `j`/`k` to move and `Enter` to open;
  - `p`/`f`/`s` to pass, fail or skip in the inbox;
  - `r` to run and `a` to assign;
  - `g i`, `g g` and `g q` to jump between screens;
  - `/` to filter;
  - a command palette (`Ctrl+K`) for "run goal X" and "open check Y".
- **Every object has a URL,** so notifications, chat cards and agent replies link straight to it.
- **Chat and hub stay linked both ways.** A chat card links to its check and run in the hub, and the hub shows which session holds a card. Acting from the hub no longer creates a session card behind the scenes. A run started from the hub belongs to the hub until someone opens it in chat.
- **Bulk actions:** run selected, add to goal, assign failing to subagents (queued one at a time under the editor rule), delete.
- **Narrow screens and the phone get the same screens as stacked lists.** The inbox's verdict flow is the main use on a phone.

### Evidence (the run screen)

The run screen shows:

- **A step timeline.** Bars for steps are laid out on the run's game time, so it is clear where time went.
- **Per step:** the expectation, the observed values charted from `observation.csv` and `tracked.jsonl` for auto steps (not a hover tooltip), captures, the `act` result, and who judged it.
- **Captures for auto steps too.** Plans can add a `capture` act to failing steps, or take one at failure; see Open questions.
- **Errors from the PIE session log** (`session_errors`) within the run's window.
- **Recording and replay.** Replay this run checks it for regressions, and the screen shows the replay's drift.
- **A comparison with the last passing run** of the same check: which steps changed and which values moved.
- **Raw files** stay available, behind a disclosure.

### Orchestration

- **Plan runs:** run a goal, run the selected checks, run what is failing, run what is stale.
- **The queue** is persisted, survives a daemon restart, and resumes when the editor reconnects. Before a run that needs it, the queue checks for unsaved levels, since ue-mcp refuses to open a map over unsaved changes.
- **Schedules:** "nightly at 02:00", or "after every N agent turns that change gameplay assets". A schedule runs only when the editor is up and idle, and is skipped and recorded otherwise.
- **Manual steps inside a plan** either block the plan, or are deferred to the inbox while the plan moves on. Each plan chooses, and deferring is the default.
- **Agent work:**
  - **Assign failing** sends each failing check to today's fix loop, one at a time.
  - **Write playtests for this goal** runs the `/playtest` flow seeded with the goal's text and existing checks, and links what it creates to the goal.
  - Both respect the Manual and Automatic setting and the PIN lock.

### Creating

- **New goal:** a title, an optional description and acceptance rules, then add checks or ask an agent to write them.
- **New playtest from the hub:** describe it (the `/playtest` flow), or start blank in the draft editor, which then needs to support creating a script, not only editing one.
- **Link existing scripts** to goals by drag or by "Add to goal".

## Architecture

### Agent

- **New `hub/` module in `apps/agent/src`:**
  - `goals.ts`: goals, checks and acceptance rules, with CRUD and status computation.
  - `run-index.ts`: durable run history.
    - Studio's runs are recorded as they finish.
    - ue-mcp's `script_runs` and `results.json` are backfilled.
    - Entries are keyed by runId, with script, goal ids, outcome, summary, timings, session and replayOf.
    - Format: `<dataDir>/hub/runs.jsonl`, append-only and compacted on start.
  - `queue.ts`: plan runs, the queue and schedules, persisted in `<dataDir>/hub/queue.json`. It runs checks through the existing `QaBroker.runScript` so cards, players and verdict routing keep working.
  - `inbox.ts`: derived from broker runs, loops and goal status.
- **Routes** under `/v1/ext/studio/hub/...`. They publish `studio.hub.changed` events in the existing style.
- **Fix the durability gaps the hub depends on:**
  - persist runs started outside Studio and the dismissed set;
  - make loops resumable, or at least visibly ended, after a restart.

### Shared and client-core

- Types in `packages/shared/src/hub.ts`.
- Status rules, sorting, copy and the inbox model in `packages/client-core/src/hub.ts`, so both clients share them.

### Web

- `apps/client-web/src/views/hub/*`, reusing `QaCard` parts for steps and verdicts.
- Visual-QA scenarios for every screen and state.

### Mobile

- Required by the parity gate. During the experiment, phone entries can be `notOnPhone` with a reason, which counts as the recorded exception. Building the inbox and goal list on the phone is the second step.

### ue-mcp asks

All of these are general features, per the rule in CLAUDE.md:

1. Export the `ScriptEvent`/`ScriptStep` types from `ue-mcp/daemon`.
2. Optionally, `tags` and `description` fields on test scripts that `script_list` returns, so grouping can travel with the asset. Goals stay in Studio either way.
3. Optionally, a capture when an auto step fails.

Studio pins 1.4.11; the sibling checkout is at 1.4.16-beta.1. Moving the pin brings `triggered`, `send_key` and `flows.stepApproval`.

## Phases

| Phase | Delivers | Done when |
|---|---|---|
| 0 | Experimental setting. Unhide the Playtests page behind it. Clean up leftovers: `sessionRuns`, `strip-*` scenario names, doubled JSDoc. | The page shows with the setting on, and tests and visual QA pass. |
| 1 | Run index and history: the check screen with history and sparkline, and the run screen with timeline, observed values and errors. | Any script shows every run it has had, and any run opens on its own URL. |
| 2 | Goals: model, status, overview, goal screen, add to goal. | A goal's status follows its checks' runs. |
| 3 | Queue and plan runs: run goal, run failing, persisted queue, resume after restart, deferred manual steps feeding the inbox. | Run goal executes every check in order without a person present, and survives a daemon restart. |
| 4 | Inbox and keyboard flow. Bulk actions. Assign failing. Write playtests for this goal. | A morning's verdicts can be cleared from the keyboard in one pass. |
| 5 | Schedules. Stale and flaky detection. Comparison with the last passing run. | A nightly run produces an overview that says what regressed. |
| 6 | Other check kinds: UAT, reproduction tests, automation filters, manual checklist items. | A goal can mix kinds. |
| 7 | The phone's inbox and goals, the rest of the parity work. | The parity gate passes with no hub `notOnPhone` entries except deliberate ones. |

## Open questions

These are the user's to decide. Answers get recorded here.

1. **Where goals live.** Recommended: `<Project>/QA/Goals/<goal-id>.json`, one JSON file per goal, checked in. Run history and the queue stay per machine in `<dataDir>/hub/`. Reasons:
   - **Shared and versioned with the game.** A goal states what this version of the game must do, so it belongs with the game's source, beside the test script assets it links to (`/Game/PIEStudio/Scripts`) and `ue-mcp.yml`. A branch that changes gameplay can change its goals in the same commit.
   - **One file per goal** avoids exclusive-checkout contention under Perforce and merge conflicts under git. Two people editing different goals never touch the same file.
   - **Plain JSON** can be read and edited without the editor running, reviewed in a diff, and written by agents. A UE data asset would need the editor, diff as binary, and need exclusive locks.
   - **Not `Config/`**, which UE reserves for ini files and stages into builds. **Not `Content/`**, which is cooked. **Not `.ue-mcp/`**, which ue-mcp uses for machine state (`native-modules.json`). **Not `ue-mcp.yml`**, which would make ue-mcp own a schema only Studio needs.
   - **Results stay local.** Runs are evidence from one machine's editor, and `results.json` already lives in the untracked `Saved/`. Goal status is computed from whichever runs this machine knows about. A shared results store is a later step, not part of goals.
   - **Format.** Checks are referenced by asset path. A path that no longer resolves shows as a missing check, offering Relink, and is never dropped silently. The folder can be overridden by a Studio setting for studios with an existing QA layout.
   - Rejected alternative: per user in `<dataDir>`. Simpler, but teammates never see each other's goals, which defeats the point for a team.
2. **How the experiment ships:** a setting on the main build, or only on a prerelease line.
3. **Mobile during the experiment:** `notOnPhone` exceptions until phase 7, or the inbox on the phone from phase 4.
4. **Captures for failing auto steps:** Studio adds `capture` acts to scripts it runs, or asks ue-mcp for a general capture-on-failure option.
5. **Where to start:** phases 0 to 2 (a visible, useful hub over today's data), or a clickable prototype of the whole hub on visual-QA fixtures first, to settle the UX before building the backend.

## Decisions

Made 2026-11-23. The user handed the design over in full: decide, build, deliver a preview.

1. **Goals live in the project** at `QA/Goals/<id>.json`, one file per goal (reasons under open question 1). Run history, queue and schedules live per machine in `<dataDir>/hub/`.
2. **Gate:** `StudioSettings.experiments.playtestHub`, off by default, switched in Settings > General. With it on, the Playtests tab shows the hub. With it off, nothing changes.
3. **Mobile:** hub scenarios get `notOnPhone` entries with a reason until the web UX settles. That is the recorded exception CONTRIBUTING.md asks for.
4. **Captures for failing auto steps:** deferred. The run screen draws the observer's values instead.
5. **Build order:** everything at once, against one contract. The backend, web UI and an interactive demo daemon are built in parallel. The demo is an in-browser simulated daemon with seed data and runs that progress, so the hub can be tried without an editor. The real backend installs with `npm run install:dev` for use with a real editor.
6. **Contract:** `packages/shared/src/hub.ts` holds every type, the status rules (`checkHealth`, `checkSatisfied`, `goalStatus`) and the route table (`HUB_ROUTES`). Agent, clients and demo all import it.
7. **Status ladder:** checks are ranked needs you, failing, missing, running, flaky, stale, never run, passing. Goals are ranked needs you, failing, at risk, running, not started, met.
