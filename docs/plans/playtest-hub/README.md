# Playtest Hub

Status: draft plan, 2026-11-22. Branch `feat/playtest-hub`. Experimental: ships behind a setting, off by default.

The Playtest Hub is the place in Studio where a team says what the game must do, sees whether it does, and puts agents to work on the gap. It manages goals, the playtests and other checks that prove them, the runs that produce evidence, and the queue that schedules those runs on the editor.

## Design review (2026-11-23, in progress)

The deferred-verdict flaw was a design error, and no code review would have caught it. Before anything new is built, the hub gets an adversarial design review from four angles. Each review writes its findings beside this plan:

- [Game state and time](review-game-state.md)
- [Teams and source control](review-teams.md)
- [Editor ownership and concurrency](review-editor.md)
- [Product coherence](review-product.md)

A consolidated triage with severity and decisions follows in `review.md`.

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
| **Needs attention** | What needs a person and does not depend on a game playing now: loops blocked, sign-offs, regressions. Replaces the Inbox (decision 12); a verdict is given live, while its step plays. | Studio (derived) |

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
| `#/playtests` | **Overview**: goals with status, Needs attention, the queue strip, recent regressions. (The Inbox screen is removed, decision 12.) |
| `#/playtests/goals/<id>` | **Goal**: its checks with health and history sparklines, its acceptance rules, Run goal, and Write playtests for this goal. |
| `#/playtests/checks` | **Library**: every script and other check, filterable by goal, status, tag, map and author, with bulk select. Grows from today's hidden page. |
| `#/playtests/checks/<script>` | **Check**: definition, history (every run, newest first), flakiness, edit. |
| `#/playtests/runs/<runId>` | **Run**: the timeline described under Evidence below. |
| `#/playtests/queue` | **Queue**: what runs now, what is next, reorder, pause, plus schedules. |

### Interaction standards

- **The status ladder is the same everywhere.** Needs you sorts above Failing, Failing above At risk, then Running, Met and Not started. The same colours and glyphs appear in pills, sparklines and the tab badge.
- **Keyboard first on wide screens:**
  - `j`/`k` to move and `Enter` to open;
  - `r` to run and `a` to assign;
  - `g o`, `g l` and `g q` to jump between screens (the Inbox's `g i` and `p`/`f`/`s` went with it, decision 12);
  - `/` to filter;
  - a command palette (`Ctrl+K`) for "run goal X" and "open check Y".
- **Every object has a URL,** so notifications, chat cards and agent replies link straight to it.
- **Chat and hub stay linked both ways.** A chat card links to its check and run in the hub, and the hub shows which session holds a card. Acting from the hub no longer creates a session card behind the scenes. A run started from the hub belongs to the hub until someone opens it in chat.
- **Bulk actions:** run selected, add to goal, assign failing to subagents (queued one at a time under the editor rule), delete.
- **Narrow screens and the phone get the same screens as stacked lists.**

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
- **Manual steps inside a plan** hold the plan, with PIE paused, until the verdict or the wait runs out; an unattended plan skips checks that have them (decision 12).
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
  - Needs attention: derived from broker runs, loops and goal status (`packages/shared/src/hub-attention.ts`).
- **Routes** under `/v1/ext/studio/hub/...`. They publish `studio.hub.changed` events in the existing style.
- **Fix the durability gaps the hub depends on:**
  - persist runs started outside Studio and the dismissed set;
  - make loops resumable, or at least visibly ended, after a restart.

### Shared and client-core

- Types in `packages/shared/src/hub.ts`.
- Status rules, sorting, copy and the Needs attention model in `packages/client-core/src/hub.ts`, so both clients share them.

### Web

- `apps/client-web/src/views/hub/*`, reusing `QaCard` parts for steps and verdicts.
- Visual-QA scenarios for every screen and state.

### Mobile

- Required by the parity gate. During the experiment, phone entries can be `notOnPhone` with a reason, which counts as the recorded exception. Building the goal list on the phone is the second step. The held-verdict bar is on the phone already.

### ue-mcp asks

All of these are general features, per the rule in CLAUDE.md. [ue-mcp-asks.md](ue-mcp-asks.md) writes up the ones the hub needs now: pausing PIE on the frame a manual step starts waiting, and exporting the script run types.

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
| 3 | Queue and plan runs: run goal, run failing, persisted queue, resume after restart, manual steps held live (decision 12). | Run goal executes every check in order, holding at manual steps for a person, and survives a daemon restart. |
| 4 | Needs attention and the keyboard flow. Bulk actions. Assign failing. Write playtests for this goal. | What needs a person can be dealt with from the Overview. |
| 5 | Schedules. Stale and flaky detection. Comparison with the last passing run. | A nightly run produces an overview that says what regressed. |
| 6 | Other check kinds: UAT, reproduction tests, automation filters, manual checklist items. | A goal can mix kinds. |
| 7 | The phone's goals, the rest of the parity work. | The parity gate passes with no hub `notOnPhone` entries except deliberate ones. |

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
3. **Mobile during the experiment:** `notOnPhone` exceptions until phase 7, or the hub on the phone from phase 4.
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
7. **Live viewport in the hub** (2026-11-23, after the user's first look). One component follows what runs now. It is live while the relevant run plays, shows the last frame briefly after it ends, and is hidden otherwise, so there is never an empty box.
   - **Placements:** large on the Run screen with the current step overlaid; a tile on the Check and Goal screens while one of their checks runs; a thumbnail in the overview's queue strip; beside live verdicts in the Inbox, so a person judges manual steps by watching from any paired browser.
   - **Revised after the user's review:** a live view that appears only while a run plays left Goal and Milestone screens empty. The viewer is now a card that is always on the layout of the Goal (and Milestone), Check and Run screens and the Inbox.
     - It never connects on its own. At rest it shows the editor's state in one line.
     - Expand connects and loads the pixels in place; a second control opens the full viewer.
     - While one of the screen's checks runs, the collapsed card says "Running now".
     - Placement: a side column on wide Goal, Check and Inbox screens, above the content when narrow; on the Run screen a line above the steps, large beside them once expanded, with the current step overlaid. Whether the cards are expanded is the hub's, so moving between screens keeps watching on the one connection.
     - The overview's queue thumbnail is gone: the queue card already names what runs, and its Viewport button opens the full viewer. Row Viewport buttons (goal check rows, queue items, the playing verdict) stay; the header buttons on Run and Check, which the card replaces, are gone.
   - **Final (user, 2026-11-23): "see the viewport when a test is running, without moving away from the current screen".**
     - A Live button in the top bar, left of Feedback, shown only while Play In Editor runs (any source), on every tab and on the phone. It opens the viewer in a modal over the current screen.
     - The Run screen keeps its large viewer with the step overlay.
     - **Remote clients only** (user, same day): a paired browser and the phone. The host Studio shows no viewport anywhere (no Live button, no card button, no Run screen viewer), since the person at the host is looking at the editor itself.
     - The per-screen inline cards and the hub's row Viewport buttons are removed. Their on-and-off flicker between runs, tied to "this screen's check runs", felt broken.
   - **The Viewport tab and the chat bar's viewport icon are removed** on web and Android, on this branch (the user's call, same day). An explicit **Viewport** button opens the full viewer from the in-chat playtest card, on both clients, and wherever a run is live in the hub. The viewer and the agent's viewport routes stay.
9. **Issue trackers: PARKED until the viewport work lands; design it deliberately, do not rush.** Corrected by the user: the hub fully owns goals, playtests and everything about them. Trackers are not a boundary of ownership. Goals and playtests (and runs) need **relationships** to their counterparts in remote trackers (Gitea, GitHub, Jira and the like).
   - **The minimum:** they store links to those counterparts.
   - **Requirement (user, 2026-11-23): provider-agnostic.** Any tracker must work: GitHub, Gitea, Jira, Trello, a Google Sheet, anything. Studio must not be on the hook for maintaining point integrations. The design supplies the indirection, and end users wire up their tool with configuration forms. Starting direction, to be designed properly:
     - **Links** are plain URLs with a relationship kind. They need no provider knowledge at all.
     - **Generic connectors configured by forms.**
       - URL templates: view an item, and open a prefilled new item from a run's report with placeholders such as `{title}`, `{body}` and `{runUrl}`.
       - Outgoing webhooks on hub events, with a documented JSON payload and optional body templates.
       - An inbound endpoint so a tracker's own automation can push state back, such as "issue closed" or "link this item to goal X".
       - Presets are only filled-in forms, never code.
     - **Code-level connectors through `packages/extension-api`.** A tracker connector contract (create item, read state, comment) that any daemon extension can implement and ship. Providers are then written by whoever needs them, outside Studio.
   - **To work out when unparked:**
     - the link model (relationship kinds such as counterpart, related, filed from this run; external id; cached state);
     - many-to-many links;
     - how links show and are edited;
     - whether anything syncs.
   - **Agent-first (user, 2026-11-23).** In most cases the project's local development agent does the tracker work. The user's own agent records Gitea issues into goals and tests and refers back to them while it works, which covers 80% or more of the need. So the near-term scope is only:
     1. a `links` field on goals, checks and runs (`url`, optional `title`, optional relationship), shown in the hub, with no sync;
     2. a JSON Schema plus a short README written next to the goal files in `QA/Goals/`, so any agent can read and write goals and links correctly;
     3. hub tools for Studio's own agent: list and read goals and checks, add links.

     Everything further (forms, webhooks, connectors, below) waits until a concrete scenario shows a need.
   - **The earlier sketch below is input to that design, not a decision:**
   1. **Links.** Goals, checks and runs carry tracker URLs, with the provider recognised from the URL for an icon. Any provider works.
   2. **File issue from a failed run.** A Markdown report built from the evidence: the failing step, expected against observed, map, run id and a link back. It opens the tracker's new-issue URL prefilled (Gitea, GitHub and GitLab take `title` and `body`), or offers "Copy as Markdown". The issue URL is linked to the run.
   3. **Outgoing webhooks and one adapter interface.**
      - Webhooks post JSON on run finished, goal status changed and regression, for studios to wire into Jira automation, chat or n8n themselves.
      - Optional adapters (create issue, read state, comment) use a per-machine token. One GitHub/Gitea adapter comes first; the two APIs match closely.
      - The adapter enables comments like "Verified: passed 3 runs in a row", issue state on goals, and Write playtests from an issue URL.
      - Jira only on demand.

   - **Configuration (sketch):** tracker type, base URL and repo in a checked-in `QA/hub.json`. Tokens never leave the machine.
10. **The relationship graph** (2026-11-23, from the user's review). The user wants no duplicates and no stale goals: one playtest may be step 1 in goal A and step 10 in goal B, and one goal may be a condition of many milestones.
    - **Today:** checks are already shared by reference across any number of goals, with per-goal order, one run history and one status. But a goal has a single `parent`, so it can sit under only one milestone. That forces duplicates.
    - **Change:** replace `parent` with one graph.
      - A goal lists what it requires, in its own order: checks and other goals (`requires: [{ goal: id }]` beside `checks`). A milestone is a goal with `kind: "milestone"`, a label rather than a separate level.
      - A goal can sit under any number of milestones or goals. Status rolls up through every path.
      - Cycles are refused. Goals and checks that nothing references show as unused, so they cannot go stale silently.
      - Requirements live in the parent's file, so adding a goal to a milestone edits only the milestone's file.
    - **When:** after the viewport card lands, since both touch the Goal screen.
12. **Manual verdicts are live only; the Inbox is removed** (user, 2026-11-23). A manual verdict means a person watched the step happen. A verdict given later, on a game that has moved on, is meaningless, so deferral and the Inbox go. This supersedes the deferral parts of the plan above (the Inbox concept, route and keys, "manual steps are deferred" under Orchestration, phases 3 and 4) and of decisions 7 and 11.
    - **Every run holds at a manual step and pauses PIE**, whoever started it (a chat card, a plan, an agent). One owner in the agent, `apps/agent/src/verdict-hold.ts`, used by `QaBroker`: when a step waits for a person it calls `editor(set_pie_paused, mode=debug)`, the editor's own Pause, available since ue-mcp 1.4.8. Script timing is game time, so no auto step's window passes meanwhile.
      - Interim: the pause lands a round trip after the step began waiting, after its act and some frames. ue-mcp-asks.md asks for `pause_on_manual`, the bridge pausing on that frame; once it ships, the agent's pause is only a feature-checked fallback.
    - **The person engages** at the editor or remotely: the playtest card, a bar under Studio's header on every tab (web and phone), and the existing notification. Resume and watch unpauses for a step that must be seen moving; nothing unpauses on its own. Then Pass, Fail or Skip; the verdict resumes PIE if it is still paused and the run goes on. On a paired browser or the phone the bar also offers Live.
    - **Timeout:** the Settings > Approvals & review setting "Wait for a verdict" (2, 5, 10, 30 or 60 minutes, default 10), or a plan's own `verdictWaitMinutes`, read when the step starts waiting. The agent publishes the deadline (`GET /qa/held`, `studio.qa.held`) and the bar counts down to it. Resume and watch does not extend it, so the deadline never moves. When it passes, or the person picks Stop now (the card's Stop route, which stops PIE too for a held run), the run and PIE stop.
    - **No verdict is no result.** A run that ended with a step nobody judged is `unjudged` ("Not judged"), reason recorded on the run and the plan item. Like `stopped` it is left out of `RESULT_OUTCOMES`: a person's absence says nothing about the game, so the run before it speaks for the check, and it does not trip Stop at the first failure. A failed step before the hold still makes the run failed.
    - **Unattended plans** (`PlanOptions.attended`, true for a person's plan, false for a schedule's unless it says otherwise) skip every check whose script has a manual step, reason "needs a person". That includes agent-judgeable steps, since a plan run has no agent assigned to judge them, and replays, which would copy an old run's verdict.
    - **Needs attention:** items that do not depend on live game state (blocked loops, sign-offs, regressions, missing checks, failed plans) are a "Needs attention" list on the Overview. The Playtests tab badge counts them; a verdict waiting live has the bar instead, so it is not counted twice.
    - The two ue-mcp asks that existed only for deferral are withdrawn.
8. **Status ladder:** checks are ranked needs you, failing, missing, running, flaky, stale, never run, passing. Goals are ranked needs you, failing, at risk, running, not started, met.
11. **Stopped runs** (2026-11-23; the deferral part superseded by decision 12). A run's outcome follows its steps, not how it ended (`outcomeOf`). A run stopped before its steps were reached is `stopped` and counts for nothing in health, acceptance or pass rate (`RESULT_OUTCOMES`), since stopping a run says nothing about the game; the run before it speaks for the check. `incomplete` (PIE or the observation ended on its own) and `error` still count as failing.
