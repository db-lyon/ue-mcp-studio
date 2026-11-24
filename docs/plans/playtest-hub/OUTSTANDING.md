# Playtest Hub: outstanding work

The branch is `feat/playtest-hub`. It is local only and the full suite passes. The final design is the top section of [review.md](review.md).

## MVP (ship 2026-11-24)

The MVP is autonomous playtests on the Playtests tab, behind the Playtest Hub experiment, which is off by default:

- goals and milestones in the per-project store;
- playtests with health and run provenance;
- running goals and playtests under the editor lease;
- the Now running strip and Needs attention.

It needs no ue-mcp changes. Everything it needs is built and verified on HubPlayground.

To ship it:

1. **Grade the hub's user-facing copy against `C:\Users\David\.agents\PROSE_EVAL.md`** with a separate reviewer, and fix anything short of PASS.
2. **Push `feat/playtest-hub` and open a pull request.** Read `C:\Users\David\.agents\PROSE.md` before writing the PR body. Never commit `keys/dev-ui-signing.pub.pem`.

## Post-MVP (revisit later)

Nothing below blocks the MVP.

- **First priority: open the hub to any agent.** Today only Studio's chat agent (hub tools) and Studio's HTTP API reach the goal store, so an external MCP agent, such as the user's own, cannot read or write goals or start plans.
  - **Fix:** ue-mcp lets an extension contribute MCP tools (a ue-mcp change first), and Studio registers its hub tools there.
  - **Also add:** a hub tool to run a goal or playtests as a plan, under the editor lease and the "Starting playtests" setting.
- **Verify live:** the verdict hold (`TS_Camera_Feel`), the live viewport from a paired browser and the phone, and store export and import.
- **ue-mcp backlog:** every item in [ue-mcp-asks.md](ue-mcp-asks.md).
- **Waiting on that backlog:** the dedicated runner editor ([runner-editor.md](runner-editor.md), needs asks 13 and 14), and replacing the interim pause (ask 1).
- **Later work:**
  - the cloud store;
  - the hub on the phone;
  - cleanups listed in [review-pragmatism.md](review-pragmatism.md);
  - a change in the editor plugin so it never swaps out `-dev.` Studio builds.
- **Sandbox:** `C:\Users\David\Projects\UE\HubPlayground` (UE 5.8, ue-mcp 1.4.16-beta.1). Install Studio with `STUDIO_DEV_BASE=0.1.46 npm run install:dev`, then `npx ue-mcp@1.4.16-beta.1 extension use studio <version> <uproject>`.
