# Playtest Hub: product coherence review

Reviewed 2026-11-23 on `feat/playtest-hub`, against the plan (decisions 1 to 12, decision 12 as written), `packages/shared/src/hub.ts`, `packages/client-core/src/hub.ts`, the hub screens and the in-chat card. The code is mid-change for decision 12; this review judges the design, not the churn.

The question throughout: does each concept and screen do one clear job for a solo developer, a QA lead at a 50-person studio, and the agent, without turning Studio into a second tracker?

## Critical

### 1. Goals are shared, but their status is true only on one machine

Goal files are checked in (decision 1). Run history is per machine, and goal status is computed from whatever runs this machine has seen. Sign-off is checked in, recorded as the account login or the literal "you".

**Scenario.** The QA lead runs the Vertical Slice milestone, sees Met and signs it off. A designer pulls, opens the hub and sees the same milestone as Not started, with the lead's sign-off already on it. A programmer whose last local run failed sees Failing. Three people, three answers, one file. The sign-off still says Met next month on a branch where nobody has run anything, because it is not tied to any run or version.

**Why it matters.** A goal's status is the hub's headline. If it depends on who is looking, the team story fails, and the hub becomes the source of disagreement it set out to settle.

**Recommendation.** Keep results local for now, but say so and pin evidence to versions:
- Label status as "on this machine" wherever a goal appears in a shared context, and show what it rests on ("from 3 runs on this PC, newest 2h ago").
- Record the commit or changelist on every `RunRecord` (cheap: `git rev-parse HEAD` or `p4 changes -m1 #have`).
- Make sign-off name the run ids and version it judged, and show it as outdated once the goal's checks have runs from a newer version.
- Treat a shared result store (or CI writing results) as the step that makes goals a team feature, and do not market the hub to teams before it exists.

### 2. Decision 12 turns an absent person into a failing game

Under decision 12, every run holds at a manual step with PIE paused, and stops after 10 minutes without a verdict. That run is `incomplete`, and decision 11 counts `incomplete` as failing in health, acceptance and pass rate.

**Scenario.** A solo developer clicks Run goal on a goal with six playtests, each with one manual step, then gets coffee. Each run waits 10 minutes, stops, and records incomplete. An hour later the goal is Failing, six checks are Failing, pass rates drop, and Assign failing offers to send six "broken" playtests to subagents that will try to fix game code that was never broken. The same happens to a QA lead whose meeting runs long.

**Why it matters.** Failing is the hub's strongest signal. Decision 12 makes "nobody watched" one of its most common causes. It also makes Run goal on anything with manual steps a sit-through-the-whole-batch commitment, with no warning up front.

**Recommendation.**
- Treat "no verdict" like `stopped`: it proves nothing about the game, so the previous result speaks for the check. Show it on the run as "Not judged" rather than Incomplete.
- Before an attended plan starts, say what it asks of the person: "4 of 6 checks need you to watch, about 2 minutes each." Offer "Run only the automatic ones" as the alternative.
- Keep `incomplete` as failing only when the game ended the run (PIE closed, observation ended, no pawn).

## Major

### 3. A check's health depends on which goal you look from

Acceptance (`stableRuns`, `staleAfterDays`) is per goal, and `checkHealth` takes it as input. The Library and the Check screen use the first goal that lists the check (`acceptanceFor`); a Goal screen uses its own goal's rule.

**Scenario.** `PT_Stagger_Wisp` is in a goal with "stale after 14 days" and a goal with "never stale". It shows Stale on one Goal screen, Passing on the other, and whichever the file order happens to put first in the Library. Decision 10 promised one run history and one status per check; the reader sees two.

**Recommendation.** Make check health a property of the check alone, with one project-wide default for stale and flaky. Leave acceptance on the goal only as "how many consecutive passes count as met", applied when rolling up the goal, never shown as the check's own health.

### 4. Check metadata lives inside goals, so it duplicates and orphans

A check's `title` and `links` are stored in each goal's `CheckRef`. The Check screen merges links from every goal and writes an added link into every goal file that lists the check. A check in no goal cannot be linked at all ("Add this check to a goal to link it").

**Scenario.** A tester files a bug from a failing run and links the issue to the check. The link is now copied into three goal files. Someone later removes it from one goal while editing; the Check screen still shows it from the other two. A new script, not yet in a goal, has nowhere to hold the issue that prompted it.

**Recommendation.** Give checks one home. Either ask ue-mcp for `description`, `tags` and links on the script asset (already ue-mcp ask 2, as a general feature), or keep one checked-in sidecar per script in `QA/Checks/`. Goals then hold only references, order and `required`.

### 5. Owner, priority, due date and tags make the hub a second tracker

Goals carry `owner`, `priority` (P0 to P3), `due` and `tags`; the overview sorts by priority then due date, and shows overdue in red.

**Scenario.** A 50-person studio already plans in Jira. The hub's P1 and due date for "Four players join a listen server" were right when someone typed them and are wrong two sprints later, because nobody updates two systems. The hub now confidently shows stale planning data beside fresh test evidence. The owner is free text, matched to nobody.

**Recommendation.** Remove owner, priority and due from goals. The tracker link (decision 9) is where planning lives; an agent can read it there. Keep tags only if a filter actually uses them. Sort by status, then title. Milestone due dates can be the one exception if a deadline is a real input to "at risk", but nothing in the status rules uses it today.

### 6. Evidence is not tied to what changed, so agent work pollutes health

Every run of a script counts, whatever started it. Flaky is "a failure within the last `stableRuns + 2` results while the newest passed". Stale is calendar age only (the plan's "not run since a change to its assets" was dropped).

**Scenario.** Assign failing sends a check to the fix loop. Attempts 1 to 4 fail, attempt 5 passes after a real fix. The check is now Flaky, its goal At risk, and its pass rate 20%, all describing the code before the fix. Meanwhile a check that passed 13 days ago against a level that was rebuilt yesterday shows Passing.

**Recommendation.** Count health only from runs since the script or its map last changed, or at least since the newest version recorded on runs (see finding 1). Exclude fix-loop attempts from pass rate and flaky, or mark them so a reader can. Define stale by change first and age second.

### 7. "Needs you" means two very different things, and there are too many status words

A goal is Needs you when a run is holding for a live verdict (urgent, minutes left) and when a sign-off is pending (any time this week). Both rank above Failing. Separately, the model has 8 check health states, 6 goal statuses, 7 run outcomes, 9 plan item states, 6 plan states and 6 step states. At risk also covers "only some checks have run", which is not risk but progress.

**Scenario.** The demo overview shows 4 of 10 goals as Needs you. Two are waiting on a sign-off nobody is in a hurry to give; the urgent paused run is mixed in among them, while Failing goals sort below both. A new user has to learn Missing, Unused, Stale, Flaky, Never run, Not started, At risk, Incomplete, Stopped, Error, Skipped and Cancelled.

**Recommendation.** The live hold belongs to the app bar (`held.ts` already does this) and to the Run screen, not to goal status. Rename the sign-off state to "Ready to sign off" and rank it below Failing. Collapse At risk to flaky or stale only, and show partial evidence as progress ("2 of 3 run"). Fold Error into Failed and Cancelled into Stopped in what people see.

### 8. Check kinds that cannot run are in the schema and the UI

`CheckKind` has five values; only `script` runs. The manual kind is a "checklist item a person signs off", satisfied by the goal's sign-off, not by anything about the item itself.

**Scenario.** An agent reads `goal.schema.json`, sees `uat` and `automation`, and adds a UAT scenario to a goal. It shows Never run forever, holds the goal at At risk, and has no Run button that works. A manual item "Combat feels weighty" is ticked off by signing the whole goal, so five manual items cannot be judged one at a time. Decision 12 says a person's judgement is live; a manual checklist item signed days later is exactly the deferred verdict decision 12 removed.

**Recommendation.** Ship the schema with `script` only. Add a kind when its runner lands, as a schema version bump. Drop `manual` as a kind: a manual step in a test script already covers "a person watched it", and goal sign-off covers "a person accepts the whole".

### 9. The first five minutes ask for goals before giving anything back

The hub sits behind an experiment toggle in Settings > General. Once on, a project with scripts but no goals lands on "No goals yet" with "Create 3 goals, one per map", which writes `QA/Goals/*.json`, a schema and a README into the repository in one click. A project with no scripts is told to go to Chat.

**Scenario.** A solo developer with eight playtests wants to know which ones are broken. They get a prompt to create goals named "L_Glade plays through". The files appear in their next commit. The useful answer (eight scripts, two failing) is a short list under the call to action.

**Recommendation.** Make the overview useful with zero goals: the check list with health, Run all and Run failing, and what just broke. Goals become an opt-in layer ("Group these into a goal") rather than the entry point. Write the schema and README only when the first goal is saved, and say where.

### 10. Hub and chat do not yet have clean jobs where agents are involved

The plan says acting from the hub no longer creates session cards. In the code, Assign failing creates a card per script (`cardFor(script, "assign-failing")`), while the Run screen's Assign calls the loop directly and fails for a hub-started run ("open a session to run the subagent in"). Where a loop does start, its progress, blocker and "Undo its changes" live only in the chat card's loop panel; the Run screen has none, yet "Fix loop stopped" in Needs attention links to the Run screen.

A run can also be seen in three places that each act on it: the chat card (run, verdict, assign, edit), the Run screen (run, verdict, assign) and the Check screen (which embeds the card for editing).

**Scenario.** A QA lead clicks Assign on a failing run in the hub and gets an error about sessions. They try Assign failing on the goal instead; it works, but the work appears as new chat sessions they did not open, and the hub item for a blocked loop opens a screen that does not show the blocker.

**Recommendation.** Give each surface one job. The hub owns state and evidence: what is true, what broke, the Run screen as the canonical record. Chat owns agent work: writing playtests and fixing them. Every agent action in the hub opens or creates a named session and goes there, the same way Write playtests already does, and the Run screen shows a one-line loop status with a link to that session. Point "Fix loop stopped" at the session, not the run.

### 11. Orchestration has little to orchestrate under live-only verdicts

Schedules skip any check with a manual step, and `needsPerson` counts agent-judgeable steps too, since a plan has no agent. Decision 12 says agent-judgeable steps "go to an agent"; the code says they are skipped. The `/playtest` flow writes scripts with manual steps as a matter of course. The Queue screen offers reorder, pause, history and schedules for one editor on a workstation that has to be left open and idle overnight.

**Scenario.** A solo developer sets up Nightly at 02:00. Next morning, 9 of 12 checks were skipped as "needs a person"; the three that ran were already passing. The schedule took a form and a Queue screen to set up and produced little.

**Recommendation.** Either give unattended plans a real judge (an assigned agent for agent-judgeable steps, as decision 12 says), or cut schedules from the first release. Show, wherever a plan or schedule is chosen, how many of its checks can run unattended. Fold the Queue into a "Now running" strip on the overview and a plans list under it; reorder and pause rarely matter with one editor and runs of a few minutes.

### 12. The words drift between playtest, check, test script and plan

The tab is Playtests. The Library lists checks. The Goal screen says "Link test scripts" and "Write playtests for this goal". The plan has plan runs; the UI says Run goal, Run selected and Queued. Assign means "hand to a subagent" on a screen that also shows an Owner, so a QA lead reads Assign failing as assigning work to people.

**Recommendation.** One word per concept, in the UI and in the schema readme: playtest for the thing that runs (keep "check" internal until a second kind runs), run for one execution, goal and milestone as they are. Rename Assign to "Fix with an agent". Do not show the word plan; "Run goal" and "Running 3 of 6" say enough.

## Minor

- **Single keys start real work.** `r` queues runs that open maps and start PIE in the user's editor, and `a` starts subagents that spend tokens and edit files. A stray keystroke while the hub has focus does either. Keep j, k, Enter, / and Ctrl+K; put run and assign behind the palette or a confirm.
- **Stale after 14 days by default.** Every goal on a project that has not been played for two weeks turns At risk at once, which teaches people to ignore At risk. Default to never stale until stale means "changed since".
- **Check screen statistics.** Pass rate, Flips and Median length beside a sparkline repeat one fact three ways and, per finding 6, often describe old code. Keep the sparkline and Last run; drop the tiles.
- **Milestones are only a label, but look like a level.** A milestone screen shows an empty Checks section saying "A goal is met when its required checks pass". Either hide Checks on milestones or drop the kind and let any goal with required goals read as a group.
- **The plan contradicts itself after decision 12.** The Concepts table still lists the Inbox, the interaction standards still bind p, f and s in it, phase 3 is "done when Run goal executes every check without a person present", phase 4 is the inbox flow, decision 11 still explains runs stopped "to defer manual steps", and decisions are numbered out of order (12 before 8). Rewrite those parts so the plan reads as one design.
- **Sign-off identity.** "you" in a checked-in file means nothing to the next reader. Require a name, or use the git user.

## What is genuinely good

- **Goals as one plain JSON file each, in the project, with a schema and a README beside them.** Diffable, mergeable under git and Perforce, editable without the editor, and readable by any agent. This is the right shape and the right home.
- **Status is computed, never typed.** Nobody can mark a goal Met by hand, which is the property that keeps the hub honest.
- **One contract.** Types, status rules and routes in `packages/shared/src/hub.ts`, imported by the agent, both clients and the demo, so the rules cannot drift between them.
- **The relationship graph.** Checks shared by reference with per-goal order, goals under many milestones, cycles refused, unused goals and checks surfaced instead of rotting silently.
- **Stopped runs count for nothing.** The right instinct, and the same principle should extend to unjudged runs (finding 2).
- **Live-only verdicts with PIE paused.** A verdict that means "a person watched this happen" is worth more than a form filled in later. The principle is sound; its consequences for status and orchestration need the fixes above.
- **Trackers as links, agent first.** No point integrations, no sync, plain URLs any agent can maintain. This is how the hub avoids becoming another source of truth, and finding 5 asks the goal fields to follow the same rule.
- **The Run screen.** Steps on the game clock, observed values drawn rather than hidden in a tooltip, the PIE log, and the comparison with the last pass give evidence chat never could. It should be the canonical record of a run.
- **Every object has a URL,** and every status has its own glyph, so nothing is told apart by colour alone.
