# Playtest Hub: outstanding work

State on 2026-11-23:

- **Branch:** `feat/playtest-hub`, local only, not pushed, no pull request.
- **Last commit:** `db38221`. The full suite passes: 3402 tests.
- **Final design:** the top section of [review.md](review.md).

## MVP scope: autonomous playtests only (user, 2026-11-23)

The MVP covers playtests whose steps are all judged automatically. Human-in-the-loop work is post-MVP: live verdicts, holds, frame-exact pausing, and judging through the viewport. The code for those already exists on the branch, and it stays.

## Before calling the MVP done

1. **Verify an autonomous run end to end** in HubPlayground: run a goal of automated playtests, then check the goal status, the provenance on each run, and that the Run screen shows evidence. This has already worked for the automated playtests.
2. **Verify store export and import:** export, import into an empty store, then a merge with a conflict report.
3. **Grade all new user-facing copy against PROSE_EVAL.md** (`C:\Users\David\.agents\PROSE_EVAL.md`) with a separate reviewer, and fix anything short of PASS. This covers:
   - hub screens;
   - the lease bar;
   - Settings rows;
   - the store export and import report.
4. **Push the branch and open a pull request.** Read `C:\Users\David\.agents\PROSE.md` before writing the PR body. Never commit `keys/dev-ui-signing.pub.pem`; it holds a local key change.

## Post-MVP: human in the loop

- **Verify the verdict hold live.** Run `TS_Camera_Feel`: PIE pauses at its manual step, and the waiting bar counts down. Then check:
  - **Resume and watch,** then **Pass:** the run continues.
  - **Let it time out:** the run reads "Not judged".
- **Verify the live viewport streams** from a paired browser and from the Android app. It has never streamed a frame so far.
- **ue-mcp asks 1/5 and 6:** frame-exact pausing, and a hold mode per step.

## Features to add to ue-mcp (backlog for the db-lyon/ue-mcp repo)

CLAUDE.md requires that anything Studio needs from ue-mcp be added to ue-mcp as a general feature, never patched around in Studio. These are those features. Each is written up in full (problem, proposed API, who benefits) in [ue-mcp-asks.md](ue-mcp-asks.md). None is open as an issue or pull request on ue-mcp yet, and none is built. The ones the MVP benefits from come first; asks 1, 5 and 6 belong to the post-MVP human-in-the-loop work.

| Ask | What | Why Studio needs it |
|---|---|---|
| 4 | Run provenance in `results.json` (script hash, dependency fingerprints, environment, single process) | Staleness by dependency change; refusing to pause runs with players in other processes |
| 10 | PIE control scoped to a run, `pie.paused` and `pie.resumed` events, a run option to never attach to existing PIE | Removes a race with the developer pressing Play |
| 7 | Structured run end causes | After a crash, the run record still shows running |
| 8 | Typed refusal codes; a verdict that applies only while still awaiting | A refusal currently fails the plan item; several clients can judge at once |
| 11 | Editor occupancy in one query, with an event | Replaces Studio's assembled occupancy signals |
| 12 | Who dirtied a package; a save scoped to a session | A precise write lease for fix loops |
| 1 / 5 | Pause PIE on the frame a person-judged step starts waiting (post-MVP) | Studio's pause lands a round trip late |
| 6 | A hold mode per step: inspect paused, or perform and watch live (post-MVP) | One hold rule cannot fit both kinds of step |
| 2 | Export the script run and event types from `ue-mcp/daemon` | Typed events in Studio |
| 9 | A stable script identity; a script's dependencies without running it | Renames, and staleness before a run |
| 13 | Editor instances of one project | The dedicated runner editor |
| 14 | A read-only editor instance | The dedicated runner editor |

## Built later, once ue-mcp ships

- **The dedicated runner editor** for unattended runs. Design: [runner-editor.md](runner-editor.md). It needs asks 13 and 14. Build Studio's side only after the daemon API exists.
- **Remove the interim agent-side pause** once ask 1 ships, behind a capability check.

## Deferred product work

- **The cloud product:** a hosted implementation of the same `GoalStore` and `EvidenceStore` interfaces. Moving to it is an upload of identical records. Tracker integrations are built there, or by others against the store; Studio ships none.
- **Phone:** the hub on the Android app. It is a recorded parity exception today (`apps/mobile/visual-qa/parity.ts`).
- **Small cleanups:** remove unused exports in `packages/shared/src/hub.ts`, listed in [review-pragmatism.md](review-pragmatism.md), and add a test for Needs attention ordering.
- **An editor plugin change** in `db-lyon/ue-mcp-studio-plugin`: never swap out a `-dev.` Studio build for a release. Until then, `STUDIO_DEV_BASE` numbers dev builds above the release.

## Sandbox test project

- **Project:** `C:\Users\David\Projects\UE\HubPlayground`. It is the UE 5.8 Third Person template, with the Studio plugin installed by `ue-mcp install studio`, and the ue-mcp 1.4.16-beta.1 bridge from the release zip.
- **Studio:** a dev build installed with `STUDIO_DEV_BASE=0.1.46 npm run install:dev`, selected with `npx ue-mcp@1.4.16-beta.1 extension use studio <version> <uproject>`.
- **Version control:** none, so runs show no revision.
