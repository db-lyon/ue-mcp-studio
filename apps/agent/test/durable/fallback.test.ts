/**
 * A durable runtime that cannot start the reply is not a dead end: the reply
 * runs on Studio's own loop, from the conversation as written, and says so.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelProvider } from "../../src/providers.js";
import { durableRunner, until, type DurableRig } from "./helpers.js";

let dir: string;
let rig: DurableRig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-fallback-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
});
afterEach(() => {
  rig?.runner.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a durable runtime that cannot start", () => {
  it("answers the message on Studio's own loop and tells the user why", async () => {
    const seen: string[] = [];
    const provider: ModelProvider = {
      run: async (req) => {
        seen.push(JSON.stringify(req.messages));
        return { content: [{ type: "text", text: "Answered without the harness." }], stopReason: "end_turn" };
      },
    };
    rig = durableRunner({
      projectDir: path.join(dir, "project"),
      dataDir: path.join(dir, "data"),
      base: "http://127.0.0.1:1",
      start: () => {
        throw new Error("the harness would not start");
      },
      extra: { provider: () => provider },
    });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "hello there");
    await until(() => rig.store.get(s.id)!.status === "idle", 15_000, "the reply to end");
    const done = rig.store.get(s.id)!;
    expect(done.error ?? null).toBeNull();
    expect(done.durable).toBeUndefined();
    expect(seen.join("")).toContain("hello there");
    expect(done.transcript.some((t) => t.kind === "note" && /could not start the reply.*Studio's own loop/.test(t.text))).toBe(true);
    expect(done.transcript.some((t) => t.kind === "assistant" && t.text.includes("Answered without the harness."))).toBe(true);
  });
});
