# Playtest Hub design review: teams, machines and source control

Reviewed 2026-11-23 on `feat/playtest-hub`, against the [plan](README.md) (decisions 1 to 12, decision 12 as written), the findings files, `packages/shared/src/hub.ts`, `apps/agent/src/hub/*` and `apps/agent/src/hub-tools.ts`. This is a design review, not a code review. The lens is a team of several people on several machines under git or Perforce, from a solo developer up to a studio with hundreds of goals.

**Summary.** The goal file format is well made for source control. The model around it is not. Goals are shared, but the evidence that decides their status lives on one machine, carries no revision, and is signed off inside the shared file. A goal therefore has as many statuses as there are machines, and none of them is the team's. Studio also writes project files as if it were the only writer: it ignores Perforce's read-only files, rewrites files nobody asked it to, and drops fields an older Studio does not know. Most other findings follow from those two.

## Critical

### 1. A goal's status is one machine's opinion, shown as the goal's status

**Scenario.** Ama runs "Tutorial glade" twice on her machine and it shows Met. She commits nothing, because runs are not files. Ben pulls the same goal file: on his machine it is Not started, since his `runs.jsonl` is empty. The build machine ran it last night and it failed there. The producer asks "is the vertical slice met?" and gets three answers, each correct for one `dataDir`.

**Why it matters.** Decision 1 shares goals and keeps runs per machine. The plan calls a shared results store "a later step, not part of goals", but status is the hub's headline and status is computed from runs. Every rule that reads history inherits the split: `stableRuns` counts only local runs, `staleAfterDays` turns a goal At risk on any machine that has not run it lately, flaky detection sees a fraction of the results, and Needs attention regressions differ by machine. Links a person files from a run ("filed-from-run") point at evidence no teammate can open.

- **Solo, one machine:** works as designed.
- **Solo, laptop and desktop:** two diverging statuses for the same goal.
- **Team:** "Met" carries no shared meaning, and nothing is the source of truth for evidence.

**Fix.** Make evidence a first-class, shareable record with provenance, and make the store pluggable:

- Each run record carries who ran it, on which machine, against which revision (git commit or Perforce changelist and stream, with a dirty flag), the script's content hash, and the engine build. Studio already reads most of this (`vcs.ts`).
- An evidence store interface with two implementations to start: the current per-machine file (the default, solo), and a shared one for teams. The simplest shared one is an append-only folder of one-file-per-run records on a path the team configures (a network share, a synced folder, or CI artifacts), which needs no server and never conflicts. A server-backed store can come later behind the same interface.
- Status is computed from the merged evidence, and the hub always says whose evidence it is: "on this machine" until a shared store is configured, "team" after.
- Runs never go into source control: one file per run in the repository would churn history and, under Perforce, flood changelists.
- ue-mcp should provide, as a general capability, a stable export of a finished run (the `results.json` summary plus provenance) that any client can publish. CI and other tools then produce the same records Studio does.

### 2. Studio writes project files without asking source control

**Scenario.** Under Perforce, synced files are read-only until opened for edit. Cara adds a check to a goal from the hub. `writeFileAtomic` writes a temporary file and renames it over the read-only goal file. Windows refuses with EPERM; the retry logic treats it as a passing lock, waits a third of a second and fails, and the hub reports an error after the agent already showed the diff for approval. On a workspace set to `allwrite`, the write succeeds but the file is not opened in any changelist, so the edit is invisible to `p4 opened` until someone reconciles, and `p4 sync` may overwrite it. New goals are never `p4 add`ed, deleted goals are removed with `rmSync` rather than `p4 delete`. The same applies to `goal.schema.json` and `README.md`.

- **Solo on git:** works.
- **Perforce team:** editing goals from the hub fails, or succeeds silently outside source control. Most large Unreal studios use Perforce, so this blocks the "bones for large studios" outright.

**Fix.** Put every project write behind one source-control step:

- Before writing an existing file, open it for edit; before creating one, mark it for add; to remove one, mark it for delete. Studio's `vcs.ts` already detects Perforce, Git, Plastic and Subversion and can grow these operations. Git needs none.
- When the open fails (file locked by someone else, offline, no login), refuse with that reason before anything is shown for approval, rather than failing after.
- Better, as a general ue-mcp capability: source-control operations through the editor's own provider (`ISourceControlModule`: check out, mark for add, delete, revert, status), so Studio, agents and other clients use the provider and changelist the team already configured.
- Report a read-only file as what it is ("checked in and not open for edit"), not as a transient lock.

## Major

### 3. Runs are not tied to the revision they tested

**Scenario.** Dev switches from `main` to `feature/new-jump`. The goal folder changes under the watcher, which is handled well. The run history does not: runs from `main` and from the branch mix in one `runs.jsonl`, keyed only by script path. Two passes on the branch plus one on `main` satisfy `stableRuns: 3`. A script whose steps were rewritten keeps the old version's history, so flakiness and pass rate compare different tests. The plan says At risk covers "not run since a change to its assets", but the code only knows age (`staleAfterDays`). A queued plan from before the switch runs checks that may not exist on the new branch, and an `error` there counts as failing.

- **Solo:** confusing after branch work; history lies quietly.
- **Team:** evidence from one branch is credited to another as soon as records are shared.

**Fix.** With the provenance from finding 1, evaluate a goal against a revision: a run counts toward a goal at revision R when it tested R, or an ancestor of R with no change since to the check's script, its map, or the assets it names (ue-mcp knows the dependencies; asset registry dependency queries are a general capability it can expose). Staleness then means "not run since a relevant change", as the plan promised, with age as a fallback. A plan records the revision it was queued at and pauses with a clear reason if the workspace moves under it.

### 4. Sign-off lives in the goal file, unverified and permanent

**Scenario.** Dana signs off "Tutorial glade" from her machine, where it is Met. `signOff: { by, at }` is written into the goal file and committed. Two weeks later the tutorial regresses and is fixed; the old sign-off still satisfies the rule, though nobody looked at the new build. Ben, on a machine with failing runs, sees a goal that is both Failing and signed off. A sign-off made on a feature branch merges into `main` and signs off a different game. Each sign-off is a commit (and under Perforce a checkout of a file someone else may have open). `by` is the Studio account login, else the registry login, else the literal `"you"`, which is then checked in.

- **Solo:** mostly harmless, apart from never expiring.
- **Team:** a sign-off is an approval, and here it is unattributable, unbound to evidence, and survives the evidence changing.

**Fix.** Treat sign-off as an attestation that belongs with evidence, not with the definition:

- The goal file keeps only the requirement (`acceptance.signOff: true`).
- A sign-off record holds the goal id, a verified identity, the time, the revision, the run ids it judged, and a hash of the goal's definition. It goes into the evidence store from finding 1.
- It counts only while it still describes the evidence: same goal definition, and no failing result for a required check since. Otherwise the goal is back to Needs you, with the old sign-off shown as history.

### 5. Studio rewrites files nobody asked it to change

**Scenario.** `GoalStore` writes `goal.schema.json` and `README.md` on every daemon start whenever their text differs from what this Studio would write. Ama is on Studio 0.1.50 and Ben on 0.1.49: each launch rewrites both files to their own version, so both always have local modifications to commit or revert. The README says Studio "replaces any edits made to them", so a team cannot add its own conventions there. Editing one goal written by an older Studio also rewrites its old `parent` milestone's file as part of the `parent` to `requires` migration, a second file in the diff (and a second checkout) for a change the person did not make.

- **Solo:** occasional noise after an upgrade.
- **Team:** permanent churn between versions, and changelists that contain files the author never touched.

**Fix.** Studio writes only what a person or agent asked to change:

- The schema is versioned and published at a stable URL (or shipped inside the extension), and goal files name it by version. Nothing is written into the project at startup.
- The README is created once, when the folder is first created, and then belongs to the team.
- Format migrations are an explicit command ("Upgrade goal files", one reviewable change across the folder), never a side effect of an unrelated edit. Until then, old fields are read and preserved as written.

### 6. An older Studio destroys data a newer one wrote

**Scenario.** Studio 0.2 adds a check kind `gauntlet` and a check field `weight`, without bumping `HUB_SCHEMA`, since the change is additive. Ben on 0.1 adds a link to that goal. `parseGoal` drops the unknown check entirely, `goalText` writes only the check fields it knows, and Ben commits a goal that silently lost a check. The same happens to a priority `p4`, a `due` with a time, or any value outside today's enums. Only unknown top-level keys are kept.

- **Solo:** rare, only across own upgrades.
- **Team:** any version skew corrupts shared goals, and review may not notice a removed line in a long JSON file.

**Fix.** Write by patching, not by regenerating:

- Keep the parsed JSON document and change only the members the operation touches; everything else is written back as read, including entries this version cannot interpret, which display as "needs a newer Studio".
- Bump the schema version for any change an older reader cannot preserve, and refuse to write files with a newer one.
- Optionally, a checked-in minimum Studio version for the project (see finding 11's config), so a teammate is told to update rather than allowed to write.

### 7. Ordinary concurrent edits conflict, and a conflict silently changes status

**Scenario.** Ama adds a link to "Tutorial glade" on one branch; Ben marks one of its checks optional on another. Both writes change `updatedAt`, one line in the same file, so every pair of concurrent edits to a goal conflicts in git, even when the fields differ. Appending to `requires` or `checks` changes the previous last line (it gains a comma), so two people adding a goal to the same milestone always conflict. Reordering replaces the whole array. If the conflict markers are committed or left in a working copy, the file fails to parse: the goal disappears from the hub with a warning, its parents report a missing requirement, the goals it required become "unused", and milestone status changes, all without an error anyone must act on.

- **Solo:** rare.
- **Team:** the milestone files are exactly where people meet, so conflicts concentrate there.

**Fix.**

- Drop `updatedAt` and `createdAt` from the file; source control already records when and by whom. If the hub needs them, read them from the VCS history or keep them per machine.
- JSON has no way to append to an array without editing the previous line, so make the order explicit instead: each requirement and check entry carries an `order` key (sparse numbers or fractional ranks), and appends add a new entry without touching existing lines. Where order does not matter, sort entries by id.
- Treat an unparsable goal file as a blocking state in the hub (the goal shown in place with "this file has a conflict"), and keep its last good parse for status until it is fixed, rather than letting it vanish from the graph.

### 8. Goal ids come from titles and collide across branches

**Scenario.** Ama on `feature/a` and Ben on `feature/b` both create "Player can jump". `freshId` checks only the local folder, so both create `QA/Goals/player-can-jump.json`. In git this is an add/add conflict between two different goals that share an id; resolved carelessly, one goal's checks and requirements merge into the other's. In Perforce the second submit fails because the file exists. A goal that requires `player-can-jump` on either branch now means something different after the merge.

- **Solo:** never.
- **Team:** likely for common titles, and the failure mode is silent merging of meaning.

**Fix.** Ids that are unique without coordination: the readable slug plus a short random suffix (`player-can-jump-k3f9`), generated at creation and never changed. The file stays named by its id, so the format barely changes. A hand-written file keeps whatever id it was given.

### 9. Checks are keyed by asset path, which UE renames freely

**Scenario.** Eli moves `/Game/Tests/Tutorial` to `/Game/QA/Tutorial` in the editor and submits the moved assets and their redirectors. Every goal file still names the old paths. On each teammate's machine, once the editor lists scripts, those checks become Missing, and Missing counts as Failing in `goalStatus`, so the milestone turns red for a rename. Run history is keyed by the old path, so after a Relink the check starts with no history. While the editor is closed, `missing` is not computed and the same goals show their old status, so status flips with the editor's connection. The reverse also happens: a goal on `main` naming a script that exists only on an unsynced branch is Failing on machines that lack it.

- **Solo:** every reorganisation of the test folder breaks goals and erases history.
- **Team:** one person's rename turns everyone's goals red.

**Fix.**

- A stable identity for scripts, as a general ue-mcp capability: test script assets carry a persistent id (or ue-mcp exposes the asset's package GUID), `script_list` returns it, and lookups follow redirectors. Goal files store the id beside the path, and runs are keyed by the id.
- Studio offers a one-step "update goal files to the new paths" when it sees a redirected or moved script, as a normal reviewed change.
- Missing becomes its own goal state ("broken reference"), not Failing, and is computed from the project's asset registry rather than from whether an editor happens to be connected.

### 10. People have no identity the hub can rely on

**Scenario.** `owner` is free text ("Ama"), `signOff.by` is a Studio account login or `"you"`, the Perforce user is `aokafor`, the git author is an email, and a manual verdict records only its source (`action`, `elicitation`), not who gave it. Under decision 12, the person judging may be on a paired phone, not at the machine that started the run. The hub cannot answer "my goals", "who approved this" or "who watched step 3 pass".

- **Solo:** irrelevant.
- **Team:** accountability for approvals and verdicts is the point of a team QA tool.

**Fix.** One identity per person in the project: an optional checked-in `QA/people.json` (or the config in finding 11) mapping a handle to the VCS user, git emails, tracker usernames and the Studio account. `owner` names a handle. Verdicts and sign-offs record the verified handle of the client that gave them; a paired client already authenticates, so the identity is available.

### 11. There is no headless runner, and schedules live on one person's machine

**Scenario.** The team wants the build machine to run every automatable goal after each submit and publish the result. Today a plan runs only inside a Studio daemon with the experiment switched on in that machine's settings, schedules sit in that machine's `queue.json` in local time, and nothing exits with a status or writes a report a CI system reads. The "nightly" a lead sets up lives on their laptop and stops when it sleeps.

- **Solo:** schedules on one's own machine are enough.
- **Team:** CI is where shared, revision-stamped evidence naturally comes from; without it, finding 1 has no producer.

**Fix.**

- A command-line plan runner: run a goal, a milestone or a scope against a project, exit non-zero on failure, write evidence records (finding 1) and a standard report such as JUnit XML. Since the runner is generic (goals are Studio's, but running scripts in order is not), the cleanest split is a general ue-mcp capability to run a list of scripts unattended with a machine-readable result, and a thin Studio command that expands goals into that list.
- Shared schedules, if wanted, as team intent in a checked-in `QA/hub.json` (which also holds the goals folder, minimum Studio version and evidence store location), with the machine that executes them chosen by a role, not by whoever created them.

### 12. A verdict nobody gave counts as a failure (decision 12)

**Scenario.** Under decision 12 an attended plan holds at each manual step and stops after the timeout with "no verdict", recorded as `incomplete`, and `incomplete` is in `RESULT_OUTCOMES`, so it counts as failing. Ama starts an attended plan, then gets pulled into a meeting; the paired phone nobody is watching cannot help. The check is Failing, its goal and milestone are Failing, and once evidence is shared (finding 1) the whole team sees a regression that is only an absence. Decision 11 already settled that a run stopped before it says anything about the game counts for nothing; "nobody judged" is the same case.

- **Solo:** a noisy red after stepping away.
- **Team:** false regressions in shared status, and pressure to set long timeouts that hold the editor.

**Fix.** Record the outcome as its own non-result ("not judged"), excluded from health and acceptance like `stopped`, and surface it in Needs attention as "needs a person to run again". Keep `incomplete` for runs the game itself could not finish. Recording who was expected to judge (finding 10) also lets the hub notify that person rather than anyone paired.

## Minor

- **One flat folder.** The store reads only `QA/Goals/*.json`, with no subfolders. Large studios assign ownership by path (Perforce protections, CODEOWNERS, review rules), and hundreds of files in one folder give them nothing to hang that on. Read subfolders recursively, keep ids unique across them, and let the folder carry the team.
- **Everything in one answer.** `GET /hub` returns every goal and check with status, recomputed on each request. Fine at dozens, slow and unwieldy at hundreds with large shared histories. Page and filter at the route, and cache status per goal, invalidated by goal and evidence changes.
- **The goals folder override.** The plan says a Studio setting can move the folder; it is not wired yet. If it becomes a per-machine setting, two teammates can read different folders. Put it in the checked-in project config.
- **Who is running what.** Two people can run the same goal at the same moment on their machines with no sign of each other. Once evidence is shared, show live runs from the shared store; no lock is needed, since editors are separate.
- **Several workspaces of one project.** Perforce users often keep several workspaces; `dataDir` is per project path, so each workspace keeps a separate history of the same game. Shared evidence (finding 1) resolves this.
- **Renaming a goal id.** There is no rename operation; renaming a file by hand leaves dangling `requires` in other files, reported only as a warning. Offer a rename that updates every referencing file in one change. Titles can already change freely without touching the id, which is right.
- **Check links per goal.** A check's links are stored in each goal that lists it and merged for display, so the same issue link is repeated and edited in several files. Keep check-level links in one place keyed by the check's stable id (finding 9).
- **Line endings.** Goal files are written with LF. Under Perforce with a `LineEnd: local` workspace on Windows this shows whole-file changes in some diff tools. Preserve the line ending the file already has.

## Checked and sound

- **One file per goal**, so different goals never touch the same file, and JSON rather than a UE asset, so files diff, merge and are edited without the editor and need no exclusive lock.
- **Requirement edges live only in the requiring goal's file**, so adding a goal to a milestone edits one file, and a goal can sit under many milestones without copies.
- **Status is never stored**, which keeps volatile state out of source control.
- **Runs are not checked in.** They should be shared (finding 1), but not through the repository.
- **Fixed key order, two-space indent and a trailing newline** keep Studio's own writes minimal and stable.
- **Tolerant reading:** a broken file is a warning and never stops the others loading; unknown top-level keys survive; a file from a newer schema is refused rather than misread.
- **The folder watch with a settle delay** picks up a sync or branch switch that writes many files at once.
- **A plan's scope is expanded when it is queued**, so goals changing mid-plan do not change what the plan runs.
- **Cycles are refused on write and reported when they arrive by merge**, and the roll-up stays finite.
- **Unused goals and checks are surfaced**, which matters more as the goal count grows.
- **Goal ids do not follow title changes**, so renaming a goal's title is a one-line diff.
- **Links are plain URLs with no provider code and no tokens in the project**, which is safe to check in.
- **The placement** (not `Config/`, `Content/` or `.ue-mcp/`, not `ue-mcp.yml`) is right for a checked-in, uncooked, Studio-owned format.
- **Agent writes to goal files go through the files approval with a diff**, so an agent cannot quietly weaken acceptance rules on a shared goal.
