# CLAUDE.md

UE-MCP Studio: the free, open-source (MIT) in-editor client for ue-mcp. The open server, bridge plugin and daemon live in `db-lyon/ue-mcp` (MIT). User guide: `docs/studio.md` in the ue-mcp repo, published at https://ue-mcp.com/docs/studio.

## Layout

- `apps/agent/` - the daemon extension. Loaded by the open ue-mcp daemon from `~/.ue-mcp/extensions/studio@<version>/`, the version each project records. Owns Studio's HTTP routes, the UI signing key it trusts, the agent loop, sessions and subagents, and the local tools.
- `apps/client-web/` - the UI. Vite + React + TypeScript, built to static files, signed, served by the daemon at `/ui/`.
- `apps/window/` - `studio-window.exe`, Studio's own window on Windows (Win32 and WebView2, built with MSVC by `scripts/build-window.mjs`). It loads the UI the daemon serves, so it stays live while the editor's game thread is busy, and answers the page's native calls itself. It ships in the extension's `bin/`; the agent's `POST /window` starts it, and opens the system browser where there is none. Docked mode holds the same unowned window over the plugin's dock tab, from the rect the plugin writes to shared memory; `apps/window/src/dock.h` is that protocol, mirrored in the plugin's `StudioDock.cpp`, and `apps/window/test/dock-test.cpp` its unit tests (built with the exe, run by `npm test`). While no page from ue-mcp is loaded, the window's local page runs `apps/window/src/connection.h`, the same connection states the UI runs in `apps/client-web/src/connection.ts`.
- `apps/mobile/` - the Android app (React Native, Expo): the paired browser's Studio drawn natively. Every user-facing change to `apps/client-web` ships with its counterpart here in the same pull request, or a recorded exception; `CONTRIBUTING.md` has the rule and `apps/mobile/test/parity-gate.test.ts` enforces it.
- `apps/window/src/app.cpp` - `UE-MCP.exe`, the UE-MCP app and its setup in one program, built beside studio-window.exe on the same host (`host.h`, `job.h`). Installed under `%LOCALAPPDATA%\Programs\UE-MCP` it is the app, organized by project: one row per project with its versions, update, daemon and editor, a detail per project (versions against the channel's newest and what Update installs, the daemon with its log, the editor), and a small Settings screen for the app's own version and channel, Node.js and Add project. It reads `ue-mcp projects --json`, a short allowlist of daemon routes (`job::allowed`), and the channel's newest releases without any daemon (`newest`: ue-mcp's npm dist-tag, `latest.json`, the plugin's `plugin.json`). Run from anywhere else it is the setup that installs it there, per user. Its page is `apps/client-web/app.html` (`src/app/`), built by `vite.app.config.ts` into `dist-app/` and compiled into the exe; it never ships in the signed `/ui/` bundle. It holds no chat: Open Studio asks the project's daemon for Studio's own window. Released as `UE-MCP-Setup.exe`, named in `latest.json` under `app`. `UE_MCP_APP_PACKAGE` points it at another ue-mcp, such as a local tarball, for development. Set `STUDIO_SIGNTOOL` to a sign command with `$f` for the file to sign it.
- `packages/shared/` - types shared by the agent and the UI.
- `packages/extension-api/` - the contract other daemon extensions build against to extend Studio (MIT, publishable): API versions, UI slots and their contexts, and the card an extension posts. Types and constants only.
- `packages/client-core/` - what both clients do that is not drawing (transport, event stream, lock, session sync, chat and review models, copy). No React, DOM or React Native. Both clients import it; neither copies it.
- `packages/remote/` - remote control (MIT, publishable): the relay wire types, end-to-end sealing between a paired browser and this computer, and `remotePath`, the rule for what a remote browser may reach.

The Unreal editor plugin `UE_MCP_Studio` (menu and toolbar entries that open Studio, the UE-MCP Studio dock tab with the setup page, native bindings, daemon launch) is its own package in `db-lyon/ue-mcp-studio-plugin`, with its own versions and releases. This repo's releases carry the extension and the UE-MCP app, not the plugin: `studio-<version>.zip`, `UE-MCP-Setup.exe` and `latest.json`, whose `pluginChannel` names the plugin's `plugin.json` and `pluginMin` the oldest plugin this Studio works with. The UI feature-detects the plugin's native calls (`apps/client-web/src/native.ts`), so a change that needs a new native call ships in the plugin first. The plugin fetches this repo's `releases/latest/download/latest.json` by a URL compiled into it: every stable release here is marked latest and must keep that file valid. A prerelease (a version with a `-` suffix) is published for testers and never becomes latest.

## The one rule about ue-mcp

Depend on ue-mcp only through `ue-mcp/daemon` (types, discovery helpers, bundle signing) and the daemon's HTTP API. Never import ue-mcp internals, never copy its code, never require a change in ue-mcp that only Studio needs. If Studio needs something the open daemon does not offer, add it to ue-mcp as a general feature first.

The packages pin one exact published `ue-mcp` version, the same in `apps/agent` and `apps/client-web`.

## Signing

UI bundles are Ed25519-signed (`signBundle` from `ue-mcp/daemon`). The daemon serves only bundles signed by a key the agent trusts.

- `npm run keys:dev` makes a dev key pair: the private key goes to `~/.ue-mcp-studio/keys/dev-ui-signing.key.pem`, never into the repo; the public key to `keys/dev-ui-signing.pub.pem`.
- The release key's public half is `keys/release-ui-signing.pub.pem`; a release agent trusts it alone. Its private half lives only on the machine that publishes, at `~/.ue-mcp-studio/keys/release-ui-signing.key.pem`, never in the repo; `npm run release` refuses to run without it.

## Development

```bash
npm install
npm run keys:dev        # once
npm run build
npm run install:dev     # agent + signed UI into ~/.ue-mcp/extensions/studio@<version>
npm run dev             # UI with hot reload, proxied to the project's daemon
```

`npm run dev` needs a daemon: `npx ue-mcp daemon start <uproject>` in the ue-mcp checkout. The dev server reads the daemon's discovery file and adds the bearer token itself. No editor is needed except for editor-dependent screens.

### Visual QA

- `npm run visual-qa -- --out <dir>` renders the real UI against stubbed daemon answers (`apps/client-web/src/visual-qa/fixtures.ts`, served as `visual-qa.html`) and screenshots every playtest state in the three themes at 1280 and 380 pixels, with an `index.md`. No daemon or editor is involved. `--widths 320,590,1280` shoots those widths instead.
- `apps/client-web/src/chat/composer-bar.layout.test.ts` measures the composer bar on the same page in headless Chrome or Edge as part of `npm test`, because jsdom has no layout.
- `npm run visual-qa -- --app --out <dir>` shoots the UE-MCP app and its setup in every state (`apps/client-web/src/app/visual-qa/fixtures.ts`) in light and dark.
- `npm run visual-qa:live` drives the same states against the StudioE2E editor through ue-mcp; its header lists the steps. It touches an editor, so run it only when the user has asked for editor runs, and it refuses without `--editor-approved`.

## Releasing

Releases are cut by hand on Windows, with the C++ tools for `studio-window.exe` and `UE-MCP.exe` and the release signing key in place. Keep the version the same in the root `package.json` and in `apps/agent`, `apps/client-web` and `apps/window`; the script refuses a mismatch. `studioPlugin.min` in the root `package.json` is the oldest editor plugin the release works with, and `ueMcpExtension.ueMcp` in `apps/agent/package.json` the oldest ue-mcp.

```bash
npm run release -- --publish --notes-file notes.md
```

It builds with only the release key trusted, signs the UI, and writes `release/studio-<version>.zip`, `release/latest.json` and `release/UE-MCP-Setup.exe` (the UE-MCP app, signed with `STUDIO_SIGNTOOL` when it is set, unsigned otherwise). Without `--publish` it stops there. With it, it creates release `v<version>` on this repo with those three files, marked latest for a stable version and as a prerelease for a version with a `-` suffix.

## Conventions

- Atomic commits, one logical change each, message says why.
- No em dashes anywhere. No session or attribution trailers in commits or PRs.
- No competitor names in commits, docs or code comments.
- The UI build targets Chrome 90 until UE 5.4 to 5.6's bundled Chromium is checked (5.7 and 5.8 ship 128, 5.9 ships 147).
