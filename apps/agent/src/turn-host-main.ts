/**
 * The turn host's entry point, bundled as dist/turn-host.js beside the
 * extension. The daemon starts it detached, with the launch file's path as its
 * one argument (turn-host.ts says what it does).
 */
import * as fs from "node:fs";
import { runSubscriptionTurn } from "./subscription.js";
import { TurnHost } from "./turn-host.js";
import type { TurnHostLaunch } from "./turn-host-protocol.js";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: turn-host <launch file>");
  const launch = JSON.parse(fs.readFileSync(file, "utf-8")) as TurnHostLaunch;
  // Read once: the record the host writes is what a daemon reattaches by.
  fs.rmSync(file, { force: true });
  const host = new TurnHost({ launch, run: runSubscriptionTurn });
  // A stray error must not take the turn down with it: it is logged, and the turn goes on.
  process.on("uncaughtException", (e) => host.log(`uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.on("unhandledRejection", (e) => host.log(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  await host.start();
  await host.done;
  process.exit(0);
}

main().catch((e: unknown) => {
  try {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  } finally {
    process.exit(1);
  }
});
