# UE-MCP Studio

The in-editor client for [ue-mcp](https://github.com/db-lyon/ue-mcp): an agent that works inside Unreal Editor through ue-mcp's actions, with sessions, subagents, attachments, flows and setup in a dock tab. Free and open source under the MIT license.

## Install

Studio comes as two packages, each with its own releases:

- **The editor plugin**, from [db-lyon/ue-mcp-studio-plugin](https://github.com/db-lyon/ue-mcp-studio-plugin/releases/latest). Unzip `UE_MCP_Studio-<version>-UE<engine>-Win64.zip` into your project's `Plugins/` folder and open the project. On first start the plugin installs ue-mcp and the Studio extension.
- **The Studio extension**, from [this repository's releases](https://github.com/db-lyon/ue-mcp-studio/releases/latest): `studio-<version>.zip` and `latest.json`, which the plugin and `npx ue-mcp@beta extension install <latest.json url> <uproject>` follow.

Unreal Engine 5.7 and 5.8 on Windows, with Node.js installed. Requires ue-mcp 1.4.0-beta.1 or later. **Settings > Update** keeps ue-mcp, the plugin and the extension current with one button.

## Models

Pick a model in the chat box. Each vendor connects through its own sign-in where it offers one, and through your API key where it does not:

- **Anthropic:** your API key. Running Claude models on your own Claude plan is an experimental option, at your own risk under Anthropic's terms.
- **OpenAI:** sign in with ChatGPT, so your ChatGPT plan pays for the calls, or your API key.
- **Google:** your API key.

## Development

See [`CLAUDE.md`](CLAUDE.md) for the layout, the rule about depending on ue-mcp, signing, and releases.

```bash
npm install
npm run build
npm test
```
