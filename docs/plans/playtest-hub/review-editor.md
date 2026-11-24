# Design review: the editor as a shared resource

Reviewed 2026-11-23 on `feat/playtest-hub`, against the plan's decisions (decision 12 as written), `apps/agent/src/hub/{queue,schedules,hub}.ts`, `qa.ts`, `verdict-hold.ts`, `playtest-loop.ts`, `viewport/pie-watch.ts` and ue-mcp's `docs/pie-scripts.md`. Part of the [Playtest Hub plan](README.md).

## The underlying flaw

The editor is the developer's workspace and the project's only test runner, and the hub has no model of who holds it. The queue decides the editor is free from Studio's own bookkeeping: no plan item live, no fix loop, no session run (`editorBusy`, `runSchedules`). Everything else that occupies an editor is invisible to that test: the developer playing in PIE, a modal dialog, a rebuild, a chat turn editing assets, another MCP client's run, unsaved levels, a person simply working. Most findings below follow from that one gap, and most fixes are the same two pieces: an explicit **editor lease** with an authoritative view of the editor's occupancy, and a **separate runner editor** for work nobody is watching.

## Critical

### 1. "Idle" means Studio started nothing, not that the editor is free

**Scenario.** The developer presses Play to try a change. Meanwhile the nightly schedule fires during a late session, or a plan queued from the phone reaches its next item. `startItem` calls `script_run` with `start_pie: true`, and ue-mcp's rule is "a session already running is used as it is". The script attaches to the developer's game: its `act` steps press keys, inject input and run console commands in it, the observer follows their pawn, and at a manual step `verdict-hold.ts` pauses their game. Ten minutes later the hold stops the run and calls `play_in_editor stop`, ending their session. If the script names another map, ue-mcp refuses instead and the item becomes an error.

**Impact.** Solo: the tool fights the person using it, at random moments. Team: any paired device can trigger this on a colleague's editor.

**Fix.** Replace `editorBusy` and the schedule's idle test with one occupancy answer that covers PIE running (Studio already tracks it in `PieWatch`), a modal dialog (`dialogs.ts`), an editor operation or build (`BusyTracker`), a chat turn with editor calls in flight, another client's active run, and recent user input. Treat PIE that the hub did not start as the developer's, always. Ask ue-mcp for a `script_run` option that refuses to attach to an existing PIE session, so a run only ever plays in a session it started.

### 2. Workspace and runner are the same editor, with no lease, consent or restore

**Scenario.** The developer is mid-edit in `L_Town` with a selection and an undo history. A queued "Run goal" item's script names `L_Arena`. If `L_Town` is saved, the run opens `L_Arena`: the selection, camera and the level's undo history are gone, and the editor stays in `L_Arena` after the plan. If `L_Town` is unsaved, ue-mcp refuses and the item errors (the plan's promise to check unsaved levels first is not implemented). The host Studio shows no viewport by decision 7, and nothing in the editor says the hub is driving it or how to stop it. A fix loop working in parallel may call `editor_restart (rebuild)` on the same editor.

**Impact.** Solo: the hub is only safe when the person has walked away, which nothing checks. Team: unusable on shared or remote-triggered editors.

**Fix.**
- **Editor lease.** Every hub activity that touches the editor (plan item, fix loop, schedule) acquires a lease with a holder, a purpose and a release. The person at the host grants it, once per plan or by a standing policy ("when I have been away 10 minutes", "outside 09:00 to 19:00"). Remote clients can request it, never take it. Unsaved levels make the request wait with a message naming the levels; the hub never saves for the person.
- **Visible holder.** While a lease is held, the editor shows a banner from the Studio plugin naming the plan and item with Stop and Pause queue. This is Studio's own plugin, so no ue-mcp change.
- **Restore.** On release, return the editor to the level it had open. Ask ue-mcp for a general editor context snapshot and restore (open level, viewport camera, selection) that any automation client can use.
- **Runner editor.** For unattended plans and fix loops, run a second editor on the project, offscreen (`-RenderOffScreen`, which ue-mcp already launches), so the workspace is never touched. The host already returns `editors()` as a list; ue-mcp should support routing calls to a named editor instance and starting one for a role. Fix loops additionally need their own working copy (finding 3).

## Major

### 3. Fix loops edit the project the person is editing

**Scenario.** A loop attempt runs for six minutes. During it the developer saves two Blueprints. The attempt's changes are the checkpoint diff (`changes(before, after)`), so the developer's saves are recorded as the attempt's, and reverting the attempt reverts their work; `edited-outside` conflict detection only catches edits after the checkpoint. If the agent and the developer both dirty one package, the review step saves the developer's half-done changes with the agent's. Separately, a chat turn can change assets a running plan check uses, so the run's verdict describes a game that changed under it.

**Impact.** Solo: silent loss or misattribution of the person's own work. Team: worse under exclusive checkout, where the loop may hold locks the person needs.

**Fix.** Run fix loops in an isolated working copy (a git worktree or a Perforce shelf workspace) with the runner editor from finding 2, and present the result as a change set the person reviews and applies. Where that is not available, attribute changes by the writes Studio's own calls made, not by the checkpoint diff, and hold a per-package write lease so the agent never saves a package the person has dirty. Mark a run tainted when project files changed between its start and end.

### 4. Interference and absence are recorded as game failures

**Scenario.** The developer presses Stop in the editor during a plan run: the run ends "PIE ended" with pending steps, `outcomeOf` returns `incomplete`, and decision 11 counts that as failing. The person steps away for ten minutes during an attended plan: the hold stops the run "no verdict", an awaiting step remains, and the result is again `incomplete`, so the goal turns Failing. An editor crash during a run is the opposite case: the queue requeues the item and the crash, the most important evidence the run produced, leaves no record.

**Impact.** Goal status reflects who was at the desk, not the game. In a team, a colleague's goals regress because someone else touched the editor.

**Fix.** Classify how a run ended by cause, as decision 11 already does for stops. "Interrupted" (a person, another client or the editor ended PIE) and "no verdict" (nobody judged in time) count for nothing, like `stopped`. "Crashed" is its own outcome and counts as failing, with the crash log attached. The ue-mcp side is a general one: a structured end cause on runs (`ended_by: person | client | timeout | crash | settled`), not only free-text `stop_reason`.

### 5. A crash retries forever, and reconnecting hands the editor straight back to the queue

**Scenario.** A check crashes the editor. `tick` sees the editor gone and queues the item again with no attempt count. The developer restarts the editor, often to answer Unreal's restore-packages dialog. On `editor.connected` the hub calls `queue.pump()` at once and starts the same check, which crashes it again. The same happens after the developer restarts the editor for their own reasons, or after a chat agent's rebuild.

**Impact.** Solo: a crash loop on the person's workspace. Team: a nightly that never completes.

**Fix.** Record the crash as the item's outcome (finding 4) and move on; retry at most once, by policy. After any reconnect, the queue waits for the lease rather than resuming on its own.

### 6. Studio applies its hold and timeout to runs and sessions it does not own

**Scenario.** Another MCP client connected to the same daemon starts a script run and asks its user for a verdict through ue-mcp's form. Studio discovers the run, `VerdictHold.observe` holds it, pauses PIE, and after ten minutes stops the run and PIE. `set_pie_paused` pauses every PIE world, and the stop calls `play_in_editor stop`, so the hold also acts on a session the run merely attached to (finding 1). When the developer pauses or resumes PIE themselves, `hold.paused` goes stale, and `release` unpauses a game the developer paused on purpose.

**Fix.** Hold only runs Studio started. Pause, resume and stop only the PIE session the run started. ue-mcp should offer run-scoped PIE control (pause the run's worlds, end the session the run started and no other) and `pie.paused` and `pie.resumed` events, so a client sees the developer's own Pause.

### 7. Refusals cascade into a failed plan

**Scenario.** A modal dialog is open, or another client's run is active (invisible to `editorBusy`, which ignores runs without a session), or a level is unsaved. Each `script_run` is refused, the item becomes `error`, and `pump` starts the next item immediately. A twelve-check plan ends in seconds as twelve errors, and a scheduled plan records "failed".

**Fix.** ue-mcp should return typed refusal codes for conditions that pass (`run_active`, `dialog_open`, `level_unsaved`, `pie_in_other_level`, `operation_in_progress`) as a general structured error, not text. The queue waits on those and shows why, and keeps `error` for genuine failures.

### 8. No single way to get the editor back, and a queue nobody can see

**Scenario.** The developer wants their editor now. Pause queue lets the current run, and any held manual step, continue. Cancel plan calls `script_stop` directly rather than `QaBroker.stopRun`, so the hold is released without being told, PIE is unpaused and left running in the test map. Fix loops are not stopped by either. Assign failing keeps its own queue in memory: it is not in `QueueState`, cannot be seen, reordered or cancelled from any client, and is lost on restart while plans survive it.

**Fix.** One activity view listing everything the hub holds or will start (plan items, fix loops, schedules due), and one **Release the editor** control that stops the current run, ends PIE the hub started, stops a running loop attempt at its next checkpoint, and pauses all queues. Persist fix loops as queue items beside plan items, under the same lease.

### 9. Nothing bounds how long the hub holds the editor

**Scenario.** An attended plan of fifteen checks, each with a manual step, runs while the person is in a meeting: fifteen ten-minute holds, two and a half hours of a paused PIE. An auto step with `within_ms` 0 waits with no timeout, and the verdict timeout does not cover it. A `triggered` step without an `act` needs a person to press a key, but `needsPerson` counts only manual steps, so an unattended nightly runs it and waits forever or records a false failure. A plan an agent starts defaults to `attended: true`, though nobody may be there.

**Fix.** A time budget per run and per plan, enforced by the queue, ending as "interrupted" (finding 4). After the first "no verdict", the plan concludes the person has gone: it skips the remaining person-judged checks or pauses the queue, by plan option. Count `triggered` steps without `act` as needing a person. Agent plans default to unattended. ue-mcp could offer a general run-level `max_duration`.

### 10. Several clients act at once with no requester or authority

**Scenario.** A paired browser queues "Run goal" on the host editor while the host user is working; any client can pause, reorder or cancel another's plan; two clients judging the same step both succeed, and the later verdict silently replaces the first. Plans record their trigger but not which client or person asked.

**Impact.** Minor solo (all clients are one person). Major for a team sharing a paired editor or a remote runner.

**Fix.** Plans and verdicts carry their requester. Starting work on an editor goes through the lease (finding 2), so the host decides. ue-mcp's `verdict` should accept an expected prior state (judge only if still awaiting), a general compare-and-set that any multi-client tool needs.

### 11. Evidence includes the developer's unsaved state

**Scenario.** PIE plays the editor's in-memory project, including unsaved edits. A plan run while the developer has a half-finished change passes, and the goal turns Met for a version of the game that was never saved or committed. Runs record no project revision or dirty packages.

**Impact.** Solo: misleading. Team: goals are shared through the project while their evidence came from one person's dirty editor.

**Fix.** Record on each run the project revision and the dirty packages at its start, show a run made over unsaved changes as such, and let acceptance rules ignore those runs. The runner editor (finding 2) removes the problem for unattended plans, since it plays saved content only.

## Minor

- **Holds live in memory.** After a daemon restart a waiting run is held again "from the moment it is read", so the deadline clients count down to moves, against decision 12's promise. Persist `dueAt` with the run.
- **Schedules cannot start an editor.** Teams that close editors at night see every nightly skipped "the editor was not connected". The runner editor answers this.
- **Plan sessions multiply.** `planSessions` is in memory, so after a restart a running plan creates another "Plan:" session for its next item.
- **Decision 12 and the code disagree** on agent-judgeable steps in unattended plans: the decision sends them to an agent, `needsPerson` skips them.

## What ue-mcp should provide

Each is general, useful to any automation client, per the rule in CLAUDE.md.

1. **Editor occupancy:** one query and its events covering the active run and the client that owns it, PIE sessions and who started them, pause state, an open modal dialog, an operation or build in progress, unsaved levels, and time since last user input.
2. **An editor lease:** acquire with holder and purpose, refusal of conflicting calls from other clients (PIE start and stop, opening a level) while it is held, release and expiry, with events.
3. **Run-scoped PIE:** a `script_run` option to require a session it starts, pause and stop limited to that session, and a run-level `max_duration`.
4. **Typed refusals and end causes** on `script_run` and on finished runs.
5. **Editor context snapshot and restore:** open level, camera and selection.
6. **Named editor instances:** route calls to a chosen editor and start an offscreen one for a role.

## Checked and sound

- One run at a time per editor is respected: plan items and fix loops exclude each other (`editorBusy`, `pumpAssign` with `queue.holding()`), and `pump` has a re-entry guard.
- The queue is written atomically and, after a daemon restart, follows its current run again when Studio still has it.
- Cancelling while an item starts stops the run that start produced.
- A plan's scope is expanded when it is queued, so it does not change under a running plan.
- Schedules skip a late run instead of firing a backlog, and record why they skipped.
- Schedules default to unattended and skip checks with manual steps.
- An agent cannot start a plan under the Manual setting.
- Pausing PIE at a manual step stops game-time windows from expiring, and Resume and watch does not extend the deadline.
- Fix loop attempts are bracketed by checkpoints, and restore refuses paths edited after the checkpoint unless the person confirms.
- With the experiment off, the hub starts nothing and asks the editor for nothing.
