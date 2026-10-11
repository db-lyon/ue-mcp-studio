# UE-MCP Studio

The in-editor client for [ue-mcp](https://github.com/db-lyon/ue-mcp): an agent that works inside Unreal Editor through ue-mcp's actions, with sessions, subagents, attachments, flows and setup in a dock tab. Free and open source under the MIT license.

## Install

Studio is a ue-mcp daemon extension plus a small editor plugin. Releases are on [ue-mcp-studio-releases](https://github.com/db-lyon/ue-mcp-studio-releases/releases):

- `studio-<version>.zip`, the extension: `npx ue-mcp@beta extension install <zip url> --sha256 <hex from latest.json>`.
- `UE_MCP_Studio-<version>-UE<engine>-Win64.zip`, the editor plugin: unpack it into the project's `Plugins/` folder.

Unreal Engine 5.7 and 5.8 on Windows. Requires ue-mcp 1.4.0-beta.1 or later.

## Models

Pick a model in the chat box. Each vendor connects through its own sign-in where it offers one, and through your API key where it does not:

- **Anthropic:** your API key. Running Claude models on your own Claude plan is an experimental option, at your own risk under Anthropic's terms.
- **OpenAI** and **Google:** your API key.

## Development

See [`CLAUDE.md`](CLAUDE.md) for the layout, the rule about depending on ue-mcp, signing, and releases.

```bash
npm install
npm run build
npm test
```
