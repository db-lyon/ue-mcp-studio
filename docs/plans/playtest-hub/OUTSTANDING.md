# Playtest Hub: outstanding work

The branch is `feat/playtest-hub`. It is local only and the full suite passes. The final design is the top section of [review.md](review.md).

## Status 2026-11-24: the port to ue-mcp is done, locally

- **Both repos are on branch `feat/playtest-hub`,** local only. All tests pass in both.
- **ue-mcp holds the hub's machinery:** the `ue-mcp/hub` (browser-safe) and `ue-mcp/daemon` exports, `/v1/hub/*` routes, the `hub` MCP tools, and its data folder `~/.ue-mcp/data/<project>/hub/`.
- **Studio is the frontend,** wiring its chat-specific pieces through `api.hub.configure`.
- **Not committed:** Studio's `package.json` and `package-lock.json` pin `ue-mcp` to a local tarball. Never commit that, or `keys/dev-ui-signing.pub.pem`.

To ship:

1. Publish the ue-mcp beta from its `feat/playtest-hub` branch. This is the owner's step.
2. Pin Studio to that published version, in `apps/agent` and `apps/client-web`, and bump `ueMcpExtension.ueMcp`.
3. Verify on HubPlayground with the new ue-mcp: run a goal of automated playtests, and check that the hub, the one-time import of the old store, and the agent's `hub` tools all work.
4. Grade the copy against PROSE_EVAL, push both branches, and open both pull requests.

## Boundary correction (user, 2026-11-23): the hub's machinery belongs in ue-mcp

Studio is a frontend, plus what that frontend directly needs. The hub's data model and machinery are core capabilities and move to ue-mcp (`db-lyon/ue-mcp`), per CLAUDE.md's rule about ue-mcp. That covers:

- the goal and milestone store;
- the status and health rules;
- the plan queue;
- run provenance and evidence;
- the editor lease;
- the agent tools.

Studio keeps the hub screens and the client-core view models, and talks to ue-mcp's API. This also gives external MCP agents the hub natively, and lets the cloud product build on ue-mcp.

Open decision: ship the hub tomorrow behind the experiment switch and move it later, with a one-time import of Studio's store into ue-mcp's; or hold the hub until the move. The recommendation is to hold it.

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

## Shipped (2026-11-24)

- **ue-mcp 1.4.16-beta.2:** the hub's machinery.
- **Studio 0.1.46-beta.2:** the hub, the Live button, Experiments, Plugins under Settings, and the Update consent fix, with APK version code 64.
- **Vale and HubPlayground** both run Studio 0.1.46-beta.2.

## Post-MVP (revisit later)

- **Dev build numbering:** `STUDIO_DEV_BASE` dev installs sort above real releases (`dev` sorts after `beta`), so Studio's "newer version installed" notice offered a stale dev build as an upgrade. Fix: Studio ignores `-dev.` builds when looking for newer installed versions, or dev builds sort below the release they are built from.

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
