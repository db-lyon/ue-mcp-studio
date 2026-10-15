# CLAUDE.md

UE-MCP Studio: the free, open-source (MIT) in-editor client for ue-mcp. The open server, bridge plugin and daemon live in `db-lyon/ue-mcp` (MIT). Spec: `plans/in-editor-client.md` in the ue-mcp repo.

## Layout

- `apps/agent/` - the daemon extension. Loaded by the open ue-mcp daemon from `~/.ue-mcp/extensions/studio/`. Owns Studio's HTTP routes, the UI signing key it trusts, and (later) the agent loop and sessions.
- `apps/client-web/` - the UI. Vite + React + TypeScript, built to static files, signed, served by the daemon at `/ui/`.
- `apps/window/` - `studio-window.exe`, Studio's own window on Windows (Win32 and WebView2, built with MSVC by `scripts/build-window.mjs`). It loads the UI the daemon serves, so it stays live while the editor's game thread is busy, and answers the page's native calls itself. It ships in the extension's `bin/`; the agent's `POST /window` starts it, and opens the system browser where there is none. Docked mode holds the same unowned window over the plugin's dock tab, from the rect the plugin writes to shared memory; `apps/window/src/dock.h` is that protocol, mirrored in the plugin's `StudioDock.cpp`, and `apps/window/test/dock-test.cpp` its unit tests (built with the exe, run by `npm test`). While no page from ue-mcp is loaded, the window's local page runs `apps/window/src/connection.h`, the same connection states the UI runs in `apps/client-web/src/connection.ts`.
- `packages/shared/` - types shared by the agent and the UI.

The Unreal editor plugin `UE_MCP_Studio` (menu and toolbar entries that open Studio, the UE-MCP Studio dock tab with the setup page, native bindings, daemon launch) is its own package in `db-lyon/ue-mcp-studio-plugin`, with its own versions and releases. This repo's releases carry the extension only: `studio-<version>.zip` and `latest.json`, whose `pluginChannel` names the plugin's `plugin.json` and `pluginMin` the oldest plugin this Studio works with. The UI feature-detects the plugin's native calls (`apps/client-web/src/native.ts`), so a change that needs a new native call ships in the plugin first. The plugin fetches this repo's `releases/latest/download/latest.json` by a URL compiled into it: every release here is marked latest and must keep that file valid.

## The one rule about ue-mcp

Depend on ue-mcp only through `ue-mcp/daemon` (types, discovery helpers, bundle signing) and the daemon's HTTP API. Never import ue-mcp internals, never copy its code, never require a change in ue-mcp that only Studio needs. If Studio needs something the open daemon does not offer, add it to ue-mcp as a general feature first.

The packages depend on a published `ue-mcp` version (the `beta` channel while the daemon is in prerelease).

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
