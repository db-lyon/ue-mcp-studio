# UE-MCP Studio

The in-editor client for [ue-mcp](https://github.com/db-lyon/ue-mcp): an agent that works inside Unreal Editor through ue-mcp's actions, with sessions, subagents, attachments, flows and setup in a window of its own. Free and open source under the MIT license.

Studio runs in its own window beside the editor, in a separate process, so the chat keeps working while the editor is busy: a long generation or a blocking call shows as "Editor busy" with a timer and a Stop, instead of freezing the panel. The window stays above the editor while either is in front, minimizes and restores with it, and remembers its place for each project. **Dock in editor** puts the same window over the editor's **UE-MCP Studio** tab instead, so it moves, resizes and hides with the tab like any other panel while still running apart from the editor; **Open as window** brings it back out. The choice is kept for each project. Docking needs editor plugin 0.1.0-beta.29 or later. On Windows it uses the WebView2 Runtime that ships with Windows 11; elsewhere Studio opens in your browser.

## Install

Studio comes as two packages, each with its own releases:

- **The editor plugin**, from [db-lyon/ue-mcp-studio-plugin](https://github.com/db-lyon/ue-mcp-studio-plugin/releases/latest). Unzip `UE_MCP_Studio-<version>-UE<engine>-Win64.zip` into your project's `Plugins/` folder and open the project. On first start the plugin's UE-MCP Studio tab lists what it installs and where: the bridge plugin, ue-mcp from npm, the Studio extension and Studio's window app. Nothing installs or downloads until you allow it there.
- **The Studio extension**, from [this repository's releases](https://github.com/db-lyon/ue-mcp-studio/releases/latest): `studio-<version>.zip` and `latest.json`, which the plugin and `npx ue-mcp extension install <latest.json url> <uproject>` follow.

Unreal Engine 5.7 and 5.8 on Windows, with Node.js installed. Requires ue-mcp 1.4.11-beta.13 or later. The **Updates** card under **Settings > General** keeps ue-mcp, the plugin and the extension current with one button. An update that restarts ue-mcp or the editor waits until no turn is running; **Restart now** installs it at once and stops the turn.

## Models

Pick a model in the chat box. Each vendor connects through its own sign-in where it offers one, and through your API key where it does not:

- **Anthropic:** your Claude subscription through the login you made in Claude Code (`claude /login`), or your API key.
- **OpenAI:** sign in with ChatGPT, so your ChatGPT plan pays for the calls, or your API key.
- **Google:** your API key.

## Tools

The agent works in the editor through ue-mcp, and on your machine through Studio's own tools: `shell` (Git Bash on Windows when Git is installed, otherwise PowerShell), `read_file`, `write_file`, `edit_file`, `glob`, `grep` and `web_fetch`, plus the model provider's own web search where the route has one. Commands run in the project folder, and relative paths start there.

Reads, searches and fetches run freely. **Settings > Approvals & review** sets, per kind, whether an agent asks first: shell commands, file changes, restarting or rebuilding the editor, and ue-mcp actions that delete or overwrite. Each kind is Ask or Allow, and shell commands and file changes can also run without asking only inside the project folder. A new install asks for all four, and the choices are kept per project. A request that asks waits in the chat with the command or the diff until you choose Allow, Allow for this session or Deny.

## Development

See [`CLAUDE.md`](CLAUDE.md) for the layout, the rule about depending on ue-mcp, signing, and releases.

```bash
npm install
npm run build
npm test
```
