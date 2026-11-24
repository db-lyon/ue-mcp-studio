# Playtest Hub design review: triage

2026-11-23. This merges four adversarial design reviews:

- [game state and time](review-game-state.md)
- [teams and source control](review-teams.md)
- [the editor as a shared resource](review-editor.md)
- [product coherence](review-product.md)

Each finding links back to its review. The reviews agree far more than they differ: most of the 40-odd findings come down to seven root problems.

## The seven root problems

### A. A run does not say what it tested (critical)

Runs record no revision, no unsaved changes, no script version, no map or player setup, and no engine build. So health, "flaky", "N stable runs", regressions, staleness and sign-off all mix results from different code. A fix that works makes a check look flaky, and a replay carries an old verdict into today's health. (Game state 1, 2, 4, 6, 9; teams 3; product 6; editor 11.)

**Decision.** Every run carries its provenance: VCS revision and whether the workspace was dirty, script content hash, map, player setup, engine version, and the run's trigger. Health, flaky and stable runs count only results on the same provenance. Mixed results across revisions read as fixed or regressed, not flaky. Stale means a dependency changed since the last pass, with age as a fallback. Replays and fix-loop attempts never count toward health.

- **Studio records** what Studio knows when it starts a run: the revision, dirty packages and trigger.
- **ue-mcp records** what only it knows, in `results.json`: script hash, dependency fingerprints and the run environment. That is ue-mcp ask 4.

### B. A goal's status is one machine's opinion (critical)

Goals are shared through source control, but the runs that decide their status live on one machine. Two people see two different statuses for the same checked-in goal, and nothing says so. (Teams 1; product 1.)

**Decision for now.** Status is always shown as what it is: "on this machine, at revision R". Evidence becomes a portable record, the run's summary plus its provenance from A, kept behind one evidence-store interface. The only store built now is local.

**Needs your call:** whether to build a shared store. It could be a checked-in `QA/Evidence/` that CI or a runner writes, or a team service. The interface makes either possible without reshaping anything.

### C. The editor is the developer's workspace, and the hub treats it as its own (critical)

"Idle" means Studio started nothing. So the hub can attach to the developer's own PIE session, send input into their game, pause it and stop it, or open another level over their work. Nothing in the editor says who is in control, and there is no single way to take it back. Fix loops edit the files the person is editing. (Editor 1, 2, 3, 5, 6, 8, 9, 10, 11.)

**Decision.**

1. **One occupancy answer** built from every signal Studio already has: PIE running, modal dialogs, builds and editor operations, chat turns with editor calls, other clients' runs, and recent input.
2. **The hub acts only on what it started.** It never holds, pauses, stops or attaches to PIE it did not start.
3. **An explicit editor lease,** shown in the editor and in Studio as "Studio is running a playtest", with one **Release the editor** control that stops everything the hub holds.
4. **After a reconnect, queues wait for the lease** instead of resuming on their own. A crash is recorded once, never retried in a loop.
5. **Fix loops take a per-package write lease:** an agent never saves a package the person has dirty, and a run that saw project files change mid-run is marked tainted.

**Needs your call:** whether unattended runs (schedules, Run all) get a dedicated runner editor, an offscreen second editor that plays only saved content. This is the clean answer to "the hub and the developer share one editor", but it is a real feature. Until it exists, unattended plans run only when the lease is granted.

### D. Verdict holds are imprecise and over-broad (critical)

Three problems:

- **The pause lands late.** The agent pauses PIE a round trip after the step started, after its act, so the person sees the aftermath rather than the moment.
- **One hold rule covers every step.** A state to inspect and a step the person must perform or watch move both get the same pause.
- **Multiplayer may not freeze.** Pausing does not freeze clients in other processes, and may trip network timeouts (unverified).

A verdict nobody gave was also counted as a failure. That is already being fixed: it becomes a non-result, and the check keeps its previous health. (Game state 3, 5, 10, 11; editor 4, 6; product 2; teams 12.)

**Decision.**

- **Interim:** the agent-side pause is acknowledged as imprecise, kept small, and refuses to pause runs with out-of-process clients.
- **Clean fix in ue-mcp:**
  - pause on the frame a person-judged step starts waiting;
  - a per-step hold mode (inspect a paused state, or perform and watch live);
  - structured end causes on runs (settled, person, client, timeout, crash);
  - typed refusal codes.

  Those are ue-mcp asks 5 to 8. Studio feature-checks each and drops its interim behaviour as each one lands.

### E. Studio writes the project behind source control's back (critical)

Three problems:

- **Bypassing source control.** On Perforce, edits to read-only files fail, and new or deleted goal files are never added to or removed from source control.
- **Unrequested writes.** Studio rewrites the schema, the README and migrated files that nobody asked it to touch.
- **Lossy writes:**
  - an older Studio drops fields a newer one wrote;
  - `updatedAt` and array appends make ordinary concurrent edits conflict;
  - ids made from titles collide across branches. (Teams 2, 5, 6, 7, 8.)

**Decision.**

- **One path for every project write,** through the VCS integration Studio already has: check out or add on Perforce, plain writes on git.
- **Studio writes only what a person or agent asked to change.** The schema and README are written once, when the first goal is created. A migration happens only when that file is saved anyway.
- **Writes patch the file instead of regenerating it,** so unknown fields survive.
- **`updatedAt` goes;** source control already knows.
- **New ids get a short random suffix** (`player-can-jump-k3f9`), so branches never collide. Existing ids stay.

### F. Sign-off and identity cannot be trusted (major)

Sign-off is permanent, says nothing about what was signed, and can be signed by the literal "you". Owners, verdicts and sign-offs have no reliable identity. (Game state 8; teams 4, 10.)

**Decision.**

- **What a sign-off records:** the revision and the run ids it was given against, plus the verified identity of whoever gave it. That is the Studio account, or the paired client's account; never a placeholder.
- **When it lapses:** a sign-off shows as "signed off on an earlier revision" once a required check fails after it, the goal's requirements change, or a dependency changes.
- **Deferred:** a checked-in people map. It is team-scale work, recorded for later.

### G. The product carries more than it needs (major)

The reviews ask for less, not more. (Product 3 to 12; editor 8.)

**Decisions:**

1. **Check health belongs to the check alone,** with one project-wide rule for flaky and stale. A goal's acceptance only says how many consecutive passes count when the goal rolls up.
2. **Check metadata gets one home.** Links and titles move out of goal files to a per-check record. ue-mcp ask 2, description, tags and links on the script asset, is the clean home. Until it lands, a sidecar in `QA/Checks/`.
3. **Remove owner, priority and due from goals.** Planning lives in the tracker the goal links to. That is your stance on not being another source of truth.
4. **The schema ships with the `script` kind only.** The `manual` kind goes: a manual step in a playtest already means "a person watched it", and sign-off means "a person accepts the goal". Other kinds return when their runners exist.
5. **The overview is useful with zero goals:** every playtest with its health, Run all, Run failing, and what just broke. Goals are an opt-in layer on top.
6. **Fewer status words:**
   - "Needs you" means a live verdict only, and it lives in the app bar and the Run screen.
   - A goal waiting for sign-off reads "Ready to sign off".
   - At risk means flaky or stale only. Partial evidence shows as progress.
7. **The hub owns state and evidence; chat owns agent work.** Every agent action in the hub opens or creates a named chat session. "Assign" becomes "Fix with an agent".
8. **Fold the Queue screen** into a "Now running" strip on the overview, with the plans list under it.
9. **Cut schedules** until there is a runner editor (C) or an agent judge, since unattended plans otherwise have little they may run.
10. **One word per concept:** playtest (the thing that runs), run, goal, milestone. "Check" stays internal until a second kind runs.
11. **Checks need an identity that survives asset renames.** ue-mcp ask 9 asks for a stable script id. Until then, Studio follows redirectors through ue-mcp, so a rename never turns goals Failing or loses history.

## FINAL: goals and milestones are tracked like issues, outside the repo (2026-11-23)

The user's correction: no service tracks issues and milestones inside the repo, because a goal on a feature branch would disagree with main. Goals and milestones are tracked like issues: in one place, not versioned per branch.

- **Now:** one local store per project at `~/.ue-mcp/data/<project>/studio/hub/`, behind one store interface. It holds goals, milestones and their graph, owner, priority and due, sign-offs and run evidence. Studio writes nothing into the game repo.
- **Later:** the cloud product hosts the same store as the team's shared copy. Moving is an upload of identical records.
- **The repo holds only the playtest scripts** (UE assets, owned by ue-mcp). Goals reference them by asset path. A script missing on the current checkout shows as missing; the goal never forks.
- **Before cloud,** a goal set moves between machines by export and import.
- **Runs record their revision** (provenance).
- **Removed:** repo writes for goals, `QA/Goals/`, `QA/Checks/`. Existing `QA/Goals/` files are imported once, non-destructively.
- **Every section below that puts goals in the repo is superseded.**

## Superseded: Studio owns goals and milestones in the repo

The user would rather give up a remote tracker than give up goals. Studio is therefore the source of truth for goals and milestones, as first-class objects:

- **Storage:** the game repo, at `QA/Goals/`, through the source-control-safe writer.
- **The goal graph stays:** goals require playtests and goals, in order; milestones stay; a goal can sit under many milestones.
- **Owner, priority and due stay on goals.** Item G3's removal is reversed because its premise, that the tracker owns planning, no longer holds.
- **Tracker links are optional and never synced.** Evidence stays per machine until cloud.
- **Rejected:** the umbrella-goal idea and the tags-only design (fresh-eyes-goals.md).

## Decided: goals live in the game repo (2026-11-23, one design)

The user asked for a single design. Goals are tracked, in the game repo at `QA/Goals/`, under source control, through the source-control-safe writer built in wave 1.

- They link to any tracker by URL.
- They version with the game and keep a team aligned today.
- The future cloud product reads the same files.
- Evidence stays per machine until that cloud product exists.

There is no local mode and no setting. The two proposals below are rejected.

## Rejected: local store now, cloud later

Gitea is one of many trackers, and a cloud product is where sharing and integrations will live. So:

- **One local store per project** (`~/.ue-mcp/data/<project>/studio/hub/`) behind one store interface. It holds goals and their graph, evidence and sign-offs. Studio writes nothing into the game repo.
- **Playtest scripts stay UE assets in the repo,** owned by ue-mcp.
- **Trackers are links only.** The project's own agent bridges them through hub tools.
- **The cloud product implements the same store interface.** Moving is an upload, and provider integrations are built once, server side.
- **Export and import of the store as a file.**
- **Existing `QA/Goals/*.json` files are imported once,** non-destructively. The repo-writing and Perforce code is removed; reading the revision for provenance stays.

## Proposed: the tracker owns coordination (2026-11-23, superseded by the section above)

The user already runs coordination in Gitea milestones and issues. Studio should not model coordination at all.

- **The tracker (Gitea)** owns coordination: the issue, its milestone, assignee, labels, discussion and state.
- **The game repo** owns acceptance: a goal file is the acceptance spec for one tracker item (`tracks: <issue url>`, the playtests that prove it, optional required goals for composition, and a title that is only a fallback).
- **Studio** owns evidence.

What follows from that:

- **Studio milestones are removed.** The Overview groups goals by tracker milestone, read through a connector, and lists tracker items that have no playtests.
- **The connector** is a small interface in `packages/extension-api`: an item's title, state, milestone and labels, plus the items in a milestone. It ships with one Gitea REST implementation (likely GitHub-compatible) with a per-machine token. Other providers come from extensions or from an inbound route an agent pushes item metadata into.
- **Studio keeps only a per-machine cache** of what the tracker said; it is not source-tracked.
- **Sign-off becomes a later write-back to the tracker** (a comment, or closing the issue) instead of a Studio record.

## Where data lives, and the path to a team tool (user question, 2026-11-23)

- **Definitions live in the game project repo:** goals in `QA/Goals/`, playtest metadata in `QA/Checks/`, and the scripts as UE assets. They branch, merge and are reviewed with the game, and stay there in the team version.
- **Evidence lives on each machine,** in Studio's per-project data folder, behind the evidence-store interface: runs, and sign-offs as attestation records.
- **The team version adds a shared evidence store** that local stores replicate into. Records do not change shape, and nothing is migrated destructively.
- **Required now, so that path stays clean:**
  - every record has an id unique across machines (an origin id per machine; ue-mcp run ids alone can collide);
  - records are append-only and immutable, so compaction archives instead of rewriting;
  - every record carries a schema version and its provenance;
  - sign-offs are records in the evidence store, not a separate per-machine file.

## Decided

The user approved everything on 2026-11-23, including the recommendation on each call:

- evidence stays local for now, honestly labelled, behind a store interface;
- a dedicated runner editor is built after the fixes;
- the removals in G go ahead.

Build order:

1. **Wave 1, in parallel:** E with F; A with B; C1 to C5.
2. **Wave 2:** G and the runner editor.
3. **Then** an adversarial review of whether the implementation choices are pragmatic.

## What needed your call

1. **A shared evidence store (B):** local only, honestly labelled, for now, or build a shared store next?
2. **A dedicated runner editor for unattended runs (C):** build it, or keep unattended plans gated on the editor lease?
3. **The removals in G:** owner, priority and due; the Queue screen; schedules for now. These are my recommendation. Say if you want any kept.

Everything else above I will implement without further questions, in this order: E and D (correctness and safety), then A, C1 to C5, F, and G.

## ue-mcp asks

These are added to [ue-mcp-asks.md](ue-mcp-asks.md), each as a general capability other clients benefit from:

4. Run provenance in `results.json`: script hash, dependency fingerprints, run environment.
5. Pause on the frame a person-judged step starts waiting.
6. A per-step hold mode (inspect or perform).
7. Structured run end causes.
8. Typed refusal codes, plus a compare-and-set verdict (judge only if still awaiting).
9. A stable script identity, plus a script's dependency set without running it.
10. Run-scoped PIE control: pause and stop only the session a run started, `pie.paused` and `pie.resumed` events, and a run option that refuses to attach to existing PIE.
