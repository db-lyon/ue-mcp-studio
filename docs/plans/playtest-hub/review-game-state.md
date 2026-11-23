# Playtest Hub design review: game state and time

Reviewed 2026-11-23 on `feat/playtest-hub`, against the [plan](README.md) through decision 12, `packages/shared/src/hub.ts`, `apps/agent/src/hub/`, `apps/agent/src/verdict-hold.ts`, `apps/agent/src/qa.ts`, and ue-mcp's `docs/pie-scripts.md` and `docs/pie.md`. Decision 12 is judged as written, not as the code currently stands.

The lens is the one behind decision 12: anywhere the design assumes the game holds still, can be judged later, or that two results are comparable when they may come from different games.

## Summary

| # | Finding | Severity |
|---|---|---|
| 1 | Runs carry no build, content or script identity, so every aggregate mixes different games | Critical |
| 2 | Replays bring old verdicts and old recordings into today's health | Critical |
| 3 | The hold pauses after the moment a person is meant to judge | Critical |
| 4 | Staleness is age only; the plan promises "since its assets changed" | Major |
| 5 | A verdict nobody gave counts as a failure | Major |
| 6 | The run's environment is neither fixed nor recorded | Major |
| 7 | Schedules and queued plans run on whatever the editor holds | Major |
| 8 | A sign-off is permanent and says nothing about what was signed | Major |
| 9 | Flaky and stable-N confuse "changed" with "nondeterministic" | Major |
| 10 | Pausing a multiplayer session is not a freeze | Major |
| 11 | One hold rule for steps that are judged and steps that are performed | Major |
| 12 | Minor issues | Minor |

## 1. Runs carry no build, content or script identity (critical)

**Scenario.** A solo developer's door check fails at 09:00. They fix the Blueprint and it passes at 15:00. With `stableRuns: 3` the goal reads "at risk" until two more passes, and the check reads flaky for the next three runs, because the window still holds the 09:00 failure from code that no longer exists. Next week they switch to a branch where the door was never fixed. The check still reads passing, from runs made on the other branch. Backfill also pulls in every `results.json` under `Saved/MCPObservations`, which survives branch switches, so months-old runs from abandoned branches count the same as today's.

**Where.** `RunRecord` has `startedAt`, `map`, `summary` and `failedSteps`, and nothing that identifies the game it ran against: no source revision, no dirty state, no script version, no map or content fingerprint, no engine or plugin version. `results.json` has none either. `checkHealth`, `checkSatisfied`, the flaky window, `buildAttention`'s regression rule, `RunDetail.lastPass` and `changedSteps` all treat a check's runs as one series.

The script itself is part of the problem. A check's id is its asset path, so editing the script keeps its history. Insert a step at index 1 and `changedSteps` compares step 3 of the new script with step 3 of the old one, which is a different step. A failure on a newly added step reads as "Failed after passing", a regression, when nothing in the game changed.

**Why it matters.** For a solo developer, the hub's central claims (met, flaky, regressed, stable) are wrong in the most common case: they changed something and ran again. For a team, goal files are shared but runs are per machine, so two people looking at the same checked-in goal see different statuses computed from different code, with nothing on screen saying so.

**Fix.**

- **ue-mcp, general:** record a run's provenance in `results.json` and on `script.run_started`: the project's source revision as the editor sees it (git HEAD or Perforce have-changelist) and whether the workspace is dirty, the engine version, a hash of the script asset as run, a hash of the map package, and the saved-package hashes of the assets the script reaches (its map, profile, and the classes its steps name). Every client that compares runs needs this, CI included.
- **Studio:** add `build: { revision, dirty, scriptHash, contentHash }` to `RunRecord`. Health, acceptance, flakiness and regressions are computed over runs of the **current script version on the current build**. Earlier runs stay in history, labelled with their build, and never count toward current status. A check with no run on the current build reads "not verified on this build" instead of passing.
- Compare steps between runs only when their `scriptHash` matches; across versions, the comparison says the script changed.

## 2. Replays bring old verdicts and old recordings into today's health (critical)

**Scenario.** A nightly schedule has `replay: true`. In `Hub.startItem`, a check with a recording skips the `needsPerson` test (`if (!src && !plan.options.attended)`), so an unattended plan replays a check with manual steps. ue-mcp copies each manual step's verdict from the source run (`verdict_source: "source_run"`). The run passes, and the check is "passing" on today's build because a person approved the door animation three weeks ago on another build. That is exactly the verdict decision 12 calls meaningless.

The auto steps have the same problem in another form. A recording is the input a person gave against the level as it was. Move a wall and the replayed input walks into it: the step fails, and the hub calls it a regression. `arrange` and `act` do not run in a replay (pie-scripts.md, "Replay regression"), so steps that depend on them fail by design. The hub never reads `drift.json`, so it cannot tell "the game changed" from "the recording no longer fits the level". The source is picked as the newest run with a `recordingId` of any outcome, so a replay can repeat a failed or stopped run's input, or a replay's (which carries its source's recording id).

**Why it matters.** Replays and live runs land in the same history with the same weight, so a cheap unattended replay can turn a goal green on evidence from a game that no longer exists. A team relying on nightly replays would trust results nobody watched.

**Fix.**

- A replay result is its own kind of evidence. `RunRecord` gains `replayOf` semantics in the health rules: a replay proves "the auto steps still hold for this recorded input", never a manual step. Steps with `verdict_source: "source_run"` count as unjudged on the replay.
- A replay counts toward current status only when its source recording was made on a compatible build (finding 1's content hash for the map and the script). Otherwise it is shown as "recording out of date" with its drift, and a live run is needed.
- Pick the replay source deliberately: the newest **passing live** run of the current script version.
- **ue-mcp, general:** let `script_replay` mark manual steps unjudged instead of copying verdicts (`manual: "inherit" | "unjudged"`), and report whether the replay stayed within its recorded drift tolerance, so "input no longer fits" is a distinct outcome from "step failed".

## 3. The hold pauses after the moment a person is meant to judge (critical)

**Scenario.** The step is "The door opens without a visible pop", a manual step whose `act` presses Interact. ue-mcp runs the act, then puts the step up for a verdict. ue-mcp emits `awaiting_verdict`, the server reads it on its next poll, the daemon publishes the event, the broker saves the run, `VerdictHold.observe` calls `editor(set_pie_paused)`, and the editor pauses. By then the door has finished opening. The person who walks up to the editor, or opens Live on the phone, sees a still frame of an open door. Resume and watch does not replay the opening; it lets the game run on from the end state. The person can only pass or fail on trust, which is the deferred verdict in a new shape.

The same holds whenever the thing to judge happens in the steps before the manual one, which is the usual way scripts are written (the example in pie-scripts.md does exactly this). Even with no act, the pause lands one round trip after the step starts, while AI, physics and timers run with nobody steering.

**Why it matters.** Decision 12 rests on "a paused game cannot drift while the person is away". The pause stops drift after the fact, but the moment the person is asked about is already gone. A solo developer at the editor may happen to be watching; a remote judge never is.

**Fix.**

- **Hold before, not after.** The person engages before the moment is played: the run holds at the start of the manual step's block, before its `act` (or before the auto steps that set it up), until the person says they are watching. Then the act plays live and the verdict follows. The timeout covers the wait to engage.
- **ue-mcp, general:** a `script_run` option to pause on the bridge's own frame, `on_manual: "pause"`, applied by the bridge on the frame a manual block begins and lifted on its verdict, plus a "ready" call that lets the block's act proceed. That removes the race, survives a Studio restart, and serves every client.
- **ue-mcp, general:** a short ring buffer of frames per run, saved as a clip when a manual step begins. The person can scrub the last seconds while paused, and an agent judging a step has motion to judge rather than one still (`capture_screenshot` of a paused frame cannot show a pop).

## 4. Staleness is age only (major)

**Scenario.** The concept table promises at risk when a check is "stale (not run since a change to its assets, or older than a set age)". `checkHealth` implements only the age: `staleAfterDays`, default 14. A check run yesterday reads passing although this morning's commit rewrote the Blueprint it tests. A check last run 15 days ago on content nobody touched reads stale, and "Run what is stale" spends editor time on it.

**Why it matters.** Age is a proxy for change, and a poor one on both ends: it misses real risk right after a change and invents risk where nothing moved. Teams with daily commits get the first error; solo projects with quiet weeks get the second.

**Fix.** Stale means "the assets this check depends on changed since its last passing run", from finding 1's dependency hashes, with age kept as an optional backstop. **ue-mcp, general:** an action that returns a script's dependency set and current fingerprints without running it, so Studio can mark checks stale as content changes rather than at the next run.

## 5. A verdict nobody gave counts as a failure (major)

**Scenario.** Under decision 12, a run whose person never answers within 10 minutes stops with reason "no verdict" and is `incomplete`. `RESULT_OUTCOMES` counts `incomplete` as a result, so the check turns Failing, the goal turns Failing, and `stopOnFailure` cancels the rest of the plan. A person who stepped out for 11 minutes makes the game look broken.

**Why it matters.** Decision 11 already says a run stopped before its steps were reached "says nothing about the game" and counts for nothing. A missed verdict says equally little. Counting it as failing teaches people to ignore Failing.

**Fix.** A distinct outcome, `unjudged`, for a run that ended only because a person did not answer. It is excluded from health and acceptance like `stopped`, keeps the auto steps' results visible on the run screen, does not trip `stopOnFailure`, and appears in Needs attention as "Not judged: run again with someone watching". An auto step that failed before the hold still makes the run failed.

## 6. The run's environment is neither fixed nor recorded (major)

**Scenarios.**

- **Level.** A script without a `map` "plays whatever level is open" (pie-scripts.md). A schedule at 02:00 runs it in whichever level the editor was left in, and the result joins the same history. `RunRecord.map` is set only when the run named one.
- **Players.** A plan item calls `runScript(card, { startPie: true })`, which means one player and no `configure_pie`. PIE then uses whatever net mode and client count the previous run left behind. A "Four players join a listen server" check, run from a plan, may run single player, or with the eight clients someone tried yesterday.
- **Frame rate.** Unattended overnight runs often go to an editor in the background, where "Use less CPU when in the background" throttles it to a few frames per second. Auto steps are judged per observed frame and physics steps grow with delta time, so results differ from an attended run in the foreground.

**Why it matters.** The history mixes runs in different levels, player counts and frame rates, and flakiness then reports the environment instead of the game.

**Fix.**

- The run configuration (map, players, net mode, one process or several) belongs to the check: the script asset, or a `run` block on `CheckRef`. A plan applies it before every run, never inheriting the editor's state. A script without a map is run only in the level it names or refused in unattended plans.
- **ue-mcp, general:** record the effective PIE configuration and frame statistics (mean and worst frame time, hitches, whether the editor was throttled in the background) in `results.json`. Studio shows them on the run screen and flags runs whose environment differs from the check's.

## 7. Schedules and queued plans run on whatever the editor holds (major)

**Scenarios.**

- PIE plays in-memory assets. A nightly schedule runs against a Blueprint the developer left half-edited and unsaved, or that an agent session is changing between plan items. The plan's report reads as the state of the game; it is the state of an unfinished edit. The plan says the queue checks for unsaved levels first; the code does not, and unsaved Blueprints and other assets are not covered by that check anyway.
- The queue resumes when the editor reconnects. The editor crashes during check 6 of 12, the developer fixes the crash, rebuilds and reopens: checks 6 to 12 run on the new build and the plan shows one result for both builds. Or the developer closes the editor for the night, switches branch, and reopens to a queued plan running on a different branch.
- An "attended" plan asserts at enqueue time that a person is there. A two-hour plan reaches its first manual step long after that person left.

**Why it matters.** A plan is presented as one coherent answer ("nightly: 3 regressed"), yet nothing guarantees one game was under test.

**Fix.**

- A plan captures finding 1's identity when it starts. Before each item it compares; on a change it stops with "the build changed" (or, by the plan's choice, carries on with the items labelled by build). Never silently.
- A schedule's precondition includes a clean editor: no dirty packages, and no agent turn holding a checkpoint. Otherwise it is skipped and the reason recorded, as for "editor busy". **ue-mcp, general:** an editor action that lists dirty packages, which the dirty flag in finding 1 can also serve.
- Attended means attended now: a plan asks for a person when it reaches a check with person-judged steps (a notification and the hold from finding 3), rather than trusting a flag set at enqueue time.

## 8. A sign-off is permanent and says nothing about what was signed (major)

**Scenario.** A lead signs off "Four players join a listen server" in March. The goal file, checked in, keeps `signOff: { by, at }` forever. In June a check fails, and the goal reads Failing. In July the netcode is rewritten and the checks pass again. The goal reads Met on March's sign-off, for a game the signer never saw. `goalStatus` treats `signOff` as satisfying every required manual check, and nothing clears it.

For a team it is worse: the sign-off travels through version control to machines whose own runs the signer never saw.

**Fix.** A sign-off records the build identity and the run ids it was given against. It lapses, shown as "signed off on an earlier build", when a required check fails after it, when the goal's checks or acceptance change, or when the build moves past it (by the project's choice: any change, or a change to the goal's dependencies).

## 9. Flaky and stable-N confuse "changed" with "nondeterministic" (major)

**Scenario.** Flaky is "mixed passes and failures within the last stableRuns+2 results while the newest passed". A check that failed before a fix and passed after it is flaky; so is a genuinely nondeterministic check. `stableRuns: 3` is met by three passes in three minutes with nothing changed between them, or by one pass on each of three builds. The first proves determinism, the second that the goal survived change, and the hub cannot tell which it has.

**Fix.** With finding 1 in place: flaky means mixed results **on the same build and script version**; mixed results across builds are a fix or a regression and are labelled so. The acceptance rule says which it wants: `stableRuns` on the current build (determinism), and optionally "passed on each of the last N builds" (endurance).

## 10. Pausing a multiplayer session is not a freeze (major)

**Scenario.** `set_pie_paused` in debug mode pauses the editor's PIE worlds. A session with clients in separate processes (Run Under One Process off, or `pie.windowless` clients) keeps running those clients. Even with every world in one process, a 10-minute hold is long past the net driver's usual connection timeout, so clients may be dropped while the person decides. On resume, clients that kept predicting are corrected by the server. The person judges a state no player saw, and remote input (`triggered_at_ms` "is when the editor heard of it") lags further.

**Why it matters.** The hub's headline multiplayer goals are exactly the ones where the hold can break the session it is meant to preserve. This needs testing before decision 12 ships for multiplayer runs.

**Fix.** **ue-mcp, general:** `set_pie_paused` reports which worlds and processes it paused and which it could not, and a paused session suspends network timeouts for its connections. Until that exists, the hold for a run with remote or out-of-process clients either refuses to pause (the run is judged live with the timeout) or the script declares it pausable.

## 11. One hold rule for steps that are judged and steps that are performed (major)

**Scenario.** A manual step's instruction is "what the person does, or what they check" (pie-scripts.md). "Jump the gap and confirm the landing feels right" is something the person must play. The hold pauses PIE on it, the person has to find Resume and watch, and the clock keeps counting from when the hold began. "The HUD shows 3 lives" is a still state, where pausing is right. "Resume and watch" for a check of motion lets the game run unsteered, so what the person sees depends on what the AI and timers did in the meantime.

**Fix.** The script says per step how it is judged: `hold: "pause"` for a state to inspect, `hold: "live"` for a step the person performs or must see in motion (which uses the hold-before rule in finding 3). This is a general step field for ue-mcp; Studio follows it instead of applying one rule to all.

## 12. Minor issues

- **The run timeline hides holds.** Bars are on game time, so a 9-minute hold vanishes. Mark the hold's wall time on the bar, so a reader knows the verdict was given after a pause and how long it took.
- **The hold's deadline moves on a daemon restart.** `verdict-hold.ts` re-holds "from the moment it is read", which restarts the timeout, contradicting "the deadline the clients count down to never moves". Persist `dueAt`, or have ue-mcp carry it on the run (part of finding 3's bridge-side pause).
- **Daylight saving.** `nextRunAt` builds local dates; a 02:30 schedule on the spring-forward night runs at 03:30, and on the fall-back night once. Acceptable, but say so in the schedule's copy.
- **Agent-judgeable steps.** Decision 12 says they "go to an agent" in unattended plans; `needsPerson` skips them. Either is defensible, but the agent needs motion evidence (finding 3's clip) before it can judge anything a still cannot show.
- **The run screen's "last passing run" comparison** picks any earlier passing run of the same asset path. Restrict it to the same script version, or label the difference (finding 1).
- **Goal edits apply retroactively.** Raising `stableRuns` or adding a check reinterprets old runs. Fine once runs are filtered by build; note it in the goal editor.

## Checked and sound

- **Decision 12's principle.** A verdict is live or it is nothing. Findings 2, 3, 5 and 8 are places the design does not yet follow its own principle.
- **Auto-step windows run on game time** (`within_ms` in game milliseconds from the observer's first frame), so a debug pause cannot use up a window, and the observer and replayer share a clock.
- **Stopped runs count for nothing** (decision 11), so a cancelled plan cannot fail a check.
- **The run screen draws a run's own steps** from its `results.json` or QaRun, not the current script, so old runs are not redrawn with today's instructions.
- **A plan expands its scope when it is queued**, so goal edits during a run do not change what it runs.
- **One run at a time per editor** is respected by the queue, fix loops and schedules, so results never interleave.
- **A schedule found more than an hour late is skipped, not run late**, which avoids running in the morning against a developer's live session.
- **Missing checks are flagged only while the editor is connected and has listed fresh**, so an offline editor never makes a goal fail.
- **The timeout is fixed when the hold begins** and Resume and watch does not extend it (apart from the restart case above).
- **Assign failing on an out-of-date failure is cheap**, since the loop's first attempt runs and reports before it changes anything. It still spends a run; finding 1 removes that.
- **Run times** come from ue-mcp's UTC wall times, so sorting and age are consistent on one machine.
