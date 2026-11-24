# The runner editor

Decision 15 in the [plan](README.md). Review C asked whether unattended runs should play in a dedicated runner editor: a second, offscreen editor of the same project that plays only saved content, so the hub never competes with the developer's editor. The owner approved it (review.md, "Decided").

**Which case applies: ue-mcp cannot do it cleanly yet, in either the pinned 1.4.11 or the 1.4.16-beta.1 checkout.** The daemon drives several editors, but only one per project root. Studio therefore writes asks 13 and 14 in [ue-mcp-asks.md](ue-mcp-asks.md) and keeps unattended plans under the workspace editor's lease (decision 14) until a daemon offers both features.

**Studio's side is not built yet** (pragmatism review, [review-pragmatism.md](review-pragmatism.md)). A first version was built against a fake daemon behind a feature check and then removed: it guessed the shape of an API ue-mcp has not designed, and carried a setting, routes, an event and a status line that could never run. The design below is what to build once ue-mcp ships asks 13 and 14, against what it actually ships. The seam that stays is the lease: `EditorLease` names its editor, so the runner holds one of its own.

## What ue-mcp offers today

Checked against `node_modules/ue-mcp` (1.4.11, `dist/`) and the sibling checkout (1.4.16-beta.1, `src/` and `docs/`).

| Capability | 1.4.11 | 1.4.16-beta.1 | Where |
|---|---|---|---|
| One daemon drives several editors | Yes, one per project | Same | `SessionRegistry` keys sessions by the normalized project root. `rekey` refuses a second session for a project: "two sessions cannot address one editor". |
| `editors[]` in `/v1/health` and `api.editors()` | One entry per session | Same | `daemon.ts` maps `rt.sessions.list()`. |
| `--editor <name-or-path>` on the CLI | Picks a session | Same | `cli/editor-flag.ts`. It chooses between projects, never between two editors of one project. |
| Routing one call to one editor | `editor` argument on any action | Same; the category is also looked up in that session's graph | `EDITOR_TARGET_PARAM = "editor"` in `surface/routing-params.ts`, resolved by `sessions.resolve`. `api.callAction` passes it through. |
| Starting, stopping or rebuilding a chosen editor from an extension | No: `editorOperation(op)` takes no target | Same | `extension-api` / `contract/daemon.ts`. |
| `editor(start_editor, window="offscreen")` | No | Yes: `-RenderOffScreen` and the background throttle off | `editor/launch-args.ts`, `tools/editor.ts`. |
| Starting a second editor of a project | Refused | Refused | `editor-control.ts` answers `alreadyRunning` when `findInteractiveEditors` finds one for the project. |
| Bridge ports | Derived from the project root | Same, plus `instances/<pid>.json` per editor | A second editor of the same project cannot bind the derived port (`SO_EXCLUSIVEADDRUSE`), moves up to 50 ports and publishes `port.json`. The client reconnects whenever a `port.json` is published, so a second editor launched by hand would take the daemon's connection away from the developer's editor. `status.json` is shared too. |
| Read-only calls | No | `callAction(..., { access: "read-only" })` (feature `callAction.access`) and per MCP session (`sessions.access`) | `flow/session-access.ts`. It refuses every action declared `mutate` or `unknown`, and `pie(script_run)` is declared `mutate`, so it cannot hold an editor that plays. It scopes calls, not an editor: autosave and save prompts are untouched. |
| Editor events name their editor | `editor.connected` and `editor.disconnected` carry `editor` | Same | `daemon.ts`. Other events (`pie.*`, `dialog.*`, `script.*`) are per session but do not distinguish two editors of one project, since there cannot be two. |

So the missing pieces are general: a second editor of one project as a session of its own, and an editor that saves nothing while still playing.

## What Unreal needs for two editors of one project

Unreal does not lock a project, and running two editors of one project is a normal way to test multiplayer by hand. What collides is shared state on disk, which ue-mcp must own when it launches an instance:

- **Derived data cache.** The local DDC is safe to share between processes, and sharing it is what keeps the second editor's start fast. Nothing to do.
- **Logs.** Both editors want `Saved/Logs/<Project>.log`. ue-mcp reads that log for the engine state, so an instance needs its own log file (`-abslog=<file>`), read by the observer for that instance.
- **Bridge state files.** `port.json` and `status.json` under `Saved/UE_MCP_Bridge/` belong to the project's editor. An instance must publish only its own instance record and status, never `port.json`.
- **Per-user settings.** An editor writes its per-project user settings (layout, recent files, editor preferences under `Saved/Config/`) when it exits. An instance must not overwrite the developer's: it reads them, and leaves them as they were.
- **Saving.** Unreal has no single switch that makes an editor read-only. The guarantee has to come from the bridge: refuse every save, turn autosave off (`[/Script/UnrealEd.EditorLoadingSavingSettings] bAutoSaveEnable` in EditorPerProjectUserSettings, through the `-ini:` override ue-mcp already uses), check nothing out from source control, and discard dirty packages on stop instead of showing the save prompt, which an offscreen editor would show to nobody.
- **Binaries.** Both editors load the project's and plugins' module DLLs, which Windows locks. A build, `editor/rebuild` or a bridge update fails while an instance runs, so ue-mcp must stop instances first and say so.
- **Cost.** A second editor roughly doubles memory, and an offscreen editor with the background throttle off uses CPU and GPU while it plays. The runner starts only for unattended work and stops after 10 minutes idle.
- **Saved content only.** A fresh editor loads packages from disk, so it plays only saved content. It does not see changes saved after it started, so the runner restarts before its next item when project files changed (ProjectWatch).

## Design (to build once ue-mcp ships asks 13 and 14)

- **`apps/agent/src/hub/runner.ts`, `RunnerEditor`.**
  - Takes only unattended run plans (`attended: false`, `work: "run"`). Attended plans need a person at the workspace editor; fix plans edit the project, which the runner never does.
  - Started on demand when the queue reaches its item, asking ue-mcp for instance `studio-runner`, offscreen and read-only. Stopped after 10 minutes with nothing to run, when a person stops it, or once idle after the setting is turned off.
  - Restarts before the next item when project files changed since it started.
  - A failed start is reported with ue-mcp's reason and retried after 5 minutes.
  - Holds its own `EditorLease("runner")`. Its occupancy is only itself: no developer input, PIE or dialogs on the workspace editor hold it.
- **`queue.ts`.** The item takes the lease of the editor its plan runs on (`QueueRunner.leaseFor`), and the queue tracks the lease it holds. Ending PIE and losing an editor are per editor (`endPie(editor)`, `editorLost(cause, editor)`), so the workspace editor going leaves the runner's item alone and the other way round. Items still run one at a time.
- **Routing.** `QaRun.editor` records the `editor` routing argument a run started with, and `QaBroker` passes it on every later call about that run (status, results, verdict, stop, PIE stop). The hub starts a runner item with `editor: "studio-runner"`. A run on the runner never counts against the workspace editor's occupancy, and PieWatch ignores events from an instance.
- **Routes and events.** `GET /hub/runner` and `POST /hub/runner/stop`, and `studio.hub.runner`, carry `{ supported, runner }` (`packages/shared/src/hub-runner.ts`). Stop runner returns an item playing there to the front of the queue and pauses the queue, as Release the editor does, then stops the editor.
- **Setting.** `runnerEditor` (on unless turned off). Settings > General shows the switch under Playtest Hub only when the daemon supports a runner.
- **UI.** One line in the Overview's Now running strip with the runner's state and Stop runner, drawing nothing while there is no runner.

## Until ue-mcp ships asks 13 and 14

Unattended plans run on the workspace editor under its lease and occupancy (decision 14), including the 5 minutes of no input on this computer. Nothing in the UI mentions the runner.

When a daemon offers both:

1. Move the pin and build the design above against the API ue-mcp shipped.
2. Add a visual QA scenario for the runner's line with its phone parity entry, and have the copy graded against PROSE_EVAL.md.
3. Run an unattended plan against the StudioE2E editor with `npm run visual-qa:live` (an editor run, so only when the owner asks).
