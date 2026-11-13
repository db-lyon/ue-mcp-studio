/**
 * A stand-in daemon for turn-host-process.test.ts: it starts a turn host the
 * way Studio's daemon does, says "ready" once the host has asked it for a
 * call, and then waits to be killed, so the test can check the
 * host outlives it. Arguments: the host script, the data folder.
 */
import * as os from "node:os";
import { TurnHosts } from "../../src/hosted-turn.js";

const [script, dataDir] = process.argv.slice(2);
const hosts = new TurnHosts({ dataDir, projectDir: os.tmpdir(), version: "1.0.0", script, log: { info() {}, warn() {} } });
await hosts.start("s-killed", {
  projectDir: os.tmpdir(),
  model: "claude-test",
  effort: "high",
  system: "",
  subagentSystem: "",
  subagents: { mode: "off", perTurn: 0, model: "claude-test", effort: "high" },
  prompt: [{ type: "text", text: "go" }],
  resume: null,
}, {
  signal: new AbortController().signal,
  onSession: () => {},
  onDelta: () => {},
  onAssistant: () => {},
  onToolResults: () => {},
  onStopper: () => {},
  onTask: () => {},
  // Never answered: this daemon is killed while the call waits.
  runTool: () => {
    process.stdout.write("ready\n");
    return new Promise(() => {});
  },
  lostTool: () => new Promise(() => {}),
});
setInterval(() => {}, 60_000);
