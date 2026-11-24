# Playtest Hub: pragmatism review

2026-11-23. An adversarial review of the implementation choices on `feat/playtest-hub` (`git diff main...HEAD`, mostly the commits after ae92225). It checked them against the owner's bar: a clean architecture, no hacks or workarounds, and no over-engineering. Product decisions in the FINAL section of [review.md](review.md) were taken as settled.

Verdicts: **fixed** (changed in place), **removed** (deleted as unjustified), **justified** (kept, with the reason), **open** (needs something Studio does not have).

## Over-engineering

| Finding | Verdict | Where |
|---|---|---|
| The runner editor was built in full against a daemon API that does not exist (`api.instances`, `api.features`). Its shape was guessed, so it would be rewritten once ue-mcp designs asks 13 and 14. It also brought a setting, two routes, an event, shared types, a status line, per-run `editor` routing through every QaBroker call, and a PieWatch filter, none of which could ever run. It also built Studio's side before the daemon feature, the reverse of the order CLAUDE.md sets. | **Removed.** Deleted `hub/runner.ts`, `shared/hub-runner.ts`, `RunnerStatus.tsx`, `hub-runner.test.ts`, the `runnerEditor` setting and switch, `/hub/runner` routes, `QaRun.editor` and `onEditor` in `qa.ts`, the queue's `leaseFor`/`heldBy` and per-editor `endPie`/`editorLost`, `ProjectWatch.mark`/`changedSince`, and the PieWatch `instance` filter. The seam that stays is `EditorLease`, which names its editor. The design stays in [runner-editor.md](runner-editor.md), marked to build once ue-mcp ships. | `apps/agent/src/hub/lease.ts:19`, `apps/agent/src/hub/queue.ts`, `apps/agent/src/qa.ts` |
| `GoalStore` and `EvidenceStore`: each interface has one implementation. | **Justified.** The planned hosted store implements both over the same records, and each interface is small. | `apps/agent/src/hub/goal-store.ts`, `apps/agent/src/hub/evidence-store.ts` |
| `Hub.queueState()` was a private method that only forwarded to `queue.state()`, beside a public `queueView()` that forwarded to it. | **Fixed.** Only `queueView()` remains. | `apps/agent/src/hub/hub.ts:818` |
| The health-rule editor models in client-core (`healthRuleText`, `HealthRuleForm`, `healthRuleErrors`, `healthRuleOf`, `HEALTH_RULE_COPY`) had no screen. | **Removed.** `PUT /hub/rules` stays for agents. | `packages/client-core/src/hub.ts` |
| Client-core re-sorted Needs attention with `sortAttention`, by the same rule `buildAttention` already applies. | **Removed.** The Overview uses the agent's order. | `apps/client-web/src/views/hub/Overview.tsx:352` |
| `PlanQueue` had a `crashed` callback nobody passed, and `idle()` and `holding()` with no callers. | **Removed.** | `apps/agent/src/hub/queue.ts` |
| `ProjectWatch.following()` had no callers. | **Removed.** | `apps/agent/src/hub/project-watch.ts` |
| `startFix` repeated the same `cardFor` call in both branches of a ternary. | **Fixed.** | `apps/agent/src/hub/hub.ts:1030` |

## Fragility

| Finding | Verdict | Where |
|---|---|---|
| Every read of a goal ran each record's full validation: `get(id)` validated every goal, and a status read did that many times. That is quadratic in the number of goals. | **Fixed.** Each stored version is validated once, cached by object in a `WeakMap`. A new version is a new object, so it is read again. | `apps/agent/src/hub/goals.ts:245` |
| Import merge brought back a record removed here: a removed record is invisible to `get`, so an older export re-added it. Decision 0 calls a removal a version, and an import keeps this store's version. | **Fixed.** A record held and removed here is reported as a conflict, "(removed here)", and left removed. Covered by a test. | `apps/agent/src/hub/goals.ts:664` |
| Import idempotency. | **Justified.** The same file twice gives `unchanged` for every record, and records compare by canonical JSON. Covered by the existing test. | `apps/agent/src/hub/goals.ts` |
| A multi-record `GoalStore.write` (a goal and its parents' requires) is one atomic file per record, but not atomic across files. | **Justified.** A crash in between leaves at most a requirement naming a missing goal, which the overview already reports. A transaction log would cost more than that case. | `apps/agent/src/hub/goal-files.ts:116` |
| File per record with hundreds of goals. | **Justified.** Startup reads one small file per record once. A change writes only its own files, and reads come from memory. | `apps/agent/src/hub/goal-files.ts` |
| Segment archive. A crash after a linked run is appended to the open segment but before the old segment moves leaves the run twice. The newest line wins, so the duplicate is harmless. `archiveOld` never archives the open segment, and it stops when only linked runs are left. | **Justified.** | `apps/agent/src/hub/run-index.ts:239` |
| The legacy `runs.jsonl` is moved in by rename, so never copied twice. If a segment 0 already exists, the file is left unread. | **Justified.** A rename leaves no half state, so that case cannot arise from Studio. | `apps/agent/src/hub/run-index.ts:189` |
| Queue races: release or cancel during an item's start, an editor lost mid-start, and a pump that arrives during a pump. | **Justified.** `pump` re-reads state after each await and stops what a cancelled or released start began. A pump arriving mid-pump is dropped, but the running loop or the item's next event picks up the change. Covered by queue tests. | `apps/agent/src/hub/queue.ts` |
| The 30-second tick beside events. | **Justified.** It is the fallback for missed events: a run whose end was missed, or an editor that went silently. Events drive everything else. | `apps/agent/src/hub/hub.ts:83` |
| `queue.json` failing to save is logged, not thrown. | **Justified.** The queue keeps working in memory, and the next change saves again. | `apps/agent/src/hub/queue.ts` |

## Leftovers

| Finding | Verdict | Where |
|---|---|---|
| The PIN lock still listed the removed `/hub/schedules` routes, and the hub's wiring comment still mentioned schedules. | **Removed.** | `apps/agent/src/remote/pin-lock.ts:126`, `apps/agent/src/chat-routes.ts` |
| Hub CSS for removed layouts: `.hub-split*` (the Goal and Check side column), `.hub-now`, `.hub-next`, `.hub-kind`, `.hub-unused-line`, `.hub-keys-hint`, `.hub-title-count`. | **Removed.** | `apps/client-web/src/views/hub/hub.css` |
| `playingFor` and the live-viewport comment were left from the per-screen Viewport cards. | **Removed and fixed.** | `packages/client-core/src/hub.ts` |
| `goal-files.ts` pointed at a `records.ts` that does not exist. | **Fixed.** | `apps/agent/src/hub/goal-files.ts` |
| The plan README still listed the Queue route, schedules, and `runs.jsonl` as the run format. | **Fixed.** It now notes that decisions override the first draft. | `docs/plans/playtest-hub/README.md` |
| Small unused exports in `packages/shared/src/hub.ts` (`onRevision`, `sameProvenance`, `checkChange`, `requirePath`, `GoalParents`, `RequiredGoalState`, and some types and limits) and rank helpers in client-core. Some are used only by tests. | **Open, low.** They are harmless. Removing them means checking each one's internal use; that is left for a separate cleanup. | `packages/shared/src/hub.ts` |

## Consistency

| Finding | Verdict | Where |
|---|---|---|
| A run's outcome mapped to a plan item's state three ways: the agent, the demo sim and the demo seed. The sim treated a stopped run as an error, and stopped a plan only on `failed`, not on error or crashed. | **Fixed.** Shared `itemStateOf` and `FAILING_ITEM_STATES` are used everywhere, with the agent's reason for the items left. | `packages/shared/src/hub.ts:1048`, `apps/client-web/src/hub-demo/sim.ts:1146`, `apps/agent/src/hub/queue.ts:350` |
| `failureOf` was copied in `verdict-hold.ts`. `write-lease.ts` had its own body parser, and goals had its own canonical JSON (`stable`) beside provenance's. | **Fixed.** All three now use `hub/util.ts`: `failureOf`, `answerOf` and `canonical`. | `apps/agent/src/verdict-hold.ts:42`, `apps/agent/src/hub/write-lease.ts:69`, `apps/agent/src/hub/util.ts:98` |
| UI copy said "check": the sign-off lapse text, the find tooltip and the Run all toasts. | **Fixed.** They say "playtest". | `packages/client-core/src/hub.ts`, `apps/client-web/src/views/hub/Hub.tsx` |
| "Is a run playing" has two forms. `runPlaying` adds `!endedAt` to the outcome check in shared `checkHealth`. The agent's `ON_EDITOR` works on `QaRunState`. | **Justified.** They answer different questions: a run record's display, and whether the editor is held. Each has one home. | `packages/client-core/src/hub.ts`, `apps/agent/src/hub/lease.ts` |
| The demo's lease always says `pie: true`. | **Justified.** The demo has no PIE ownership to model; the agent reads `pieStarted`. | `apps/client-web/src/hub-demo/sim.ts` |
| `/hub/fix` and `POST /hub/store` are not PIN-locked. | **Justified.** This matches the card's `/qa/runs/:id/assign`, which is not locked either. Locking fix loops would be a policy change for both. | `apps/agent/src/remote/pin-lock.ts` |

## Migrations

| Finding | Verdict | Where |
|---|---|---|
| The per-machine `sign-offs.json` an earlier build kept was dropped. | **Fixed (migrated).** It has the same shape and validator as a sign-off record. It is taken in once, for goals the store has, and recorded as import `sign-offs`; the file is only read. Covered by a test. | `apps/agent/src/hub/goals.ts:763` |
| A `queue.json` saved before ae92225 has plans with `manualSteps` and no `attended`, which read as unattended and silently skipped every manual playtest. | **Fixed.** Saved plan options are read through `planOptionsOf` over the defaults. Unknown keys go, and a missing `attended` means a person's plan. A top-level `schedules` was already ignored. Covered by a test. | `apps/agent/src/hub/queue.ts:146` |
| Runs recorded with source `schedule`. | **Justified.** They read as `plan`. | `apps/agent/src/hub/run-index.ts` |
| The one-time QA/Goals import. | **Justified.** It runs once into an empty store, read only, and records what it took and what it could not read. | `apps/agent/src/hub/goals.ts` |

## Open

- **Verdict holds and out-of-process clients.** Review D's interim says the agent refuses to pause runs with out-of-process clients. Studio cannot tell whether a multiplayer PIE session runs in one process, so the pause still applies to every run that started its own PIE. One process is the PIE default. This needs `single_process` in the run environment (ask 4) or a `set_pie_paused` that reports what it paused.
- **Styles outside the hub.** `styles.css` has unused selectors for the playtest card and the flow view (`.qa-scroll-cue`, `.flow-view`, `.graph-*`). They predate this branch and are left for a general cleanup.
