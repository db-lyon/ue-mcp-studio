# UE-MCP Studio

The in-editor client for [ue-mcp](https://github.com/db-lyon/ue-mcp): an agent that works inside Unreal Editor through ue-mcp's actions, with sessions, subagents, attachments, flows and setup in a window of its own. Free and open source under the MIT license.

Studio runs in its own window beside the editor, in a separate process, so the chat keeps working while the editor is busy: a long generation or a blocking call shows as "Editor busy" with a timer and a Stop, instead of freezing the panel. The window stays above the editor while either is in front, minimizes and restores with it, and remembers its place for each project. **Dock in editor** puts the same window over the editor's **UE-MCP Studio** tab instead, so it moves, resizes and hides with the tab like any other panel while still running apart from the editor; **Open as window** brings it back out. The choice is kept for each project. On Windows it uses the WebView2 Runtime that ships with Windows 11; elsewhere Studio opens in your browser.

## Install

Close the project in Unreal, then either:

- **Install the UE-MCP app**, [UE-MCP-Setup.exe](https://github.com/db-lyon/ue-mcp-studio/releases/latest/download/UE-MCP-Setup.exe). It installs for your Windows user with no administrator rights, checks for Node.js 20 or newer and offers to install it. The app lists your Unreal projects: choose **Add Studio** on one and it runs the command below. It also launches the editor, opens each project's Studio, shows what has an update across your projects, and lists the ue-mcp daemons running with their logs. It does not hold the chat, which stays in each project's Studio.
- **Or run one command** in your project folder, the one holding the `.uproject`:

  ```bash
  npx ue-mcp install studio
  ```

Either way the project gets the Studio editor plugin for its engine, Studio itself, and, if the project is not set up for ue-mcp yet, the bridge plugin and its config. Every download is checked against its SHA-256. Then open the project in Unreal and click **Studio** on the toolbar.

Unreal Engine 5.7, 5.8 and 5.9 on Windows, with Node.js installed. The **Updates** card under **Settings > General** keeps ue-mcp, the plugin and Studio current with one button. An update that restarts ue-mcp or the editor waits until no turn is running; **Restart now** installs it at once and stops the turn.

Studio comes as two packages, each with its own releases: the editor plugin from [db-lyon/ue-mcp-studio-plugin](https://github.com/db-lyon/ue-mcp-studio-plugin/releases/latest), which you can also unzip into your project's `Plugins/` folder by hand, and the agent and UI from [this repository's releases](https://github.com/db-lyon/ue-mcp-studio/releases/latest): `studio-<version>.zip` and `latest.json`, which the plugin and `npx ue-mcp install studio` follow, and `UE-MCP-Setup.exe`, the UE-MCP app.

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
