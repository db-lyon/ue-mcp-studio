# CLAUDE.md

UE-MCP Studio: the paid, closed-source in-editor client for ue-mcp. Private repo. The open server, bridge plugin and daemon live in `db-lyon/ue-mcp` (MIT). Spec: `plans/in-editor-client.md` in that repo.

## Layout

- `apps/agent/` - the daemon extension. Loaded by the open ue-mcp daemon from `~/.ue-mcp/extensions/studio/`. Owns Studio's HTTP routes, the UI signing key it trusts, and (later) the agent loop and sessions.
- `apps/client-web/` - the UI. Vite + React + TypeScript, built to static files, signed, served by the daemon at `/ui/`.
- `apps/client-plugin/` - the Unreal editor plugin `UE_MCP_Studio`: dock tab, browser view, native bindings, daemon launch. `StudioHost/` is the project it is built and tested in.
- `packages/shared/` - types shared by the agent and the UI.
- Gateway and billing apps arrive in phase 6.

## The one rule about ue-mcp

Depend on ue-mcp only through `ue-mcp/daemon` (types, discovery helpers, bundle signing) and the daemon's HTTP API. Never import ue-mcp internals, never copy its code, never require a change in ue-mcp that only Studio needs. If Studio needs something the open daemon does not offer, add it to ue-mcp as a general feature first.

Until the daemon is in a published ue-mcp release, the packages depend on `file:../../../ue-mcp-main`, a worktree of ue-mcp `main` built with `npx tsc`. Switch to the published version when it exists.

## Signing

UI bundles are Ed25519-signed (`signBundle` from `ue-mcp/daemon`). The daemon serves only bundles signed by a key the agent trusts.

- `npm run keys:dev` makes a dev key pair: the private key goes to `~/.ue-mcp-studio/keys/dev-ui-signing.key.pem`, never into the repo; the public key to `keys/dev-ui-signing.pub.pem`.
- The release key's private half lives only in CI secrets. Its public half is added to `keys/` when release signing exists (phase 4).

## Development

```bash
npm install
npm run keys:dev        # once
npm run build
npm run install:dev     # agent + signed UI into ~/.ue-mcp/extensions/studio
npm run dev             # UI with hot reload, proxied to the project's daemon
```

`npm run dev` needs a daemon: `npx ue-mcp daemon start <uproject>` in the ue-mcp checkout. The dev server reads the daemon's discovery file and adds the bearer token itself. No editor is needed except for editor-dependent screens.

## Conventions

- Atomic commits, one logical change each, message says why.
- No em dashes anywhere. No session or attribution trailers in commits or PRs.
- No competitor names in commits, docs or code comments.
- The UI build targets Chrome 90 until UE 5.4 to 5.6's bundled Chromium is checked (5.7 and 5.8 ship 128).
