/**
 * A turn host process for turn-host-process.test.ts: the real TurnHost, with a
 * scripted turn in place of the Agent SDK. It says one thing, calls one of
 * Studio's tools and waits for a daemon to answer, then reports the answer and
 * ends. The test bundles this file and starts it as the daemon would.
 */
import * as fs from "node:fs";
import { TurnHost } from "../../src/turn-host.js";
import type { SubscriptionTurn } from "../../src/subscription.js";
import type { TurnHostLaunch } from "../../src/turn-host-protocol.js";

const file = process.argv[2];
const launch = JSON.parse(fs.readFileSync(file, "utf-8")) as TurnHostLaunch;
fs.rmSync(file, { force: true });

async function run(t: SubscriptionTurn): Promise<string | null> {
  t.onSession("proc-session");
  t.onAssistant("m1", [{ type: "text", text: `running in process ${process.pid}` }], null);
  t.onAssistant("m2", [{ type: "tool_use", id: "c1", name: "shell", input: { command: "echo hi" } }], null);
  const exec = await t.runTool("c1", "shell", { command: "echo hi" });
  t.onToolResults([{ type: "tool_result", tool_use_id: "c1", content: exec.text, is_error: exec.isError }], null);
  t.onAssistant("m3", [{ type: "text", text: `the daemon answered: ${exec.text}` }], null);
  return null;
}

const host = new TurnHost({ launch, run, endAckMs: 5000 });
process.on("uncaughtException", (e) => host.log(`uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
process.on("unhandledRejection", (e) => host.log(`unhandled rejection: ${String(e)}`));
process.on("exit", (code) => host.log(`exit ${code}`));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => host.log(`signal ${sig}`));
await host.start();
await host.done;
process.exit(0);
