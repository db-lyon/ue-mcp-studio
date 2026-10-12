import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UpdateQueue, type DeferredStep } from "../src/update-queue.js";

let dir: string;
let busy: boolean;
let ran: DeferredStep[];
let interrupted: number;
let published: Array<{ type: string; data: Record<string, unknown> }>;

const queue = () =>
  new UpdateQueue({
    dataDir: dir,
    busy: () => busy,
    run: async (step) => {
      ran.push(step);
      return { ok: true, started: step !== "plugin" };
    },
    interruptTurns: () => {
      interrupted++;
      busy = false;
    },
    publish: (type, data) => published.push({ type, data }),
    pollMs: 60_000,
  });

const runFile = () => path.join(dir, "update-run.json");
const savedRun = () => JSON.parse(fs.readFileSync(runFile(), "utf-8")) as { steps: Array<{ key: string; state: string }> };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-queue-"));
  busy = false;
  ran = [];
  interrupted = 0;
  published = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("an update step while a turn is in progress", () => {
  it("runs at once when nothing is in progress", async () => {
    const q = queue();
    expect(await q.request("studio")).toMatchObject({ ok: true, started: true });
    expect(ran).toEqual(["studio"]);
    q.stop();
  });

  it("waits, with the steps after it, and runs them in order once every turn is idle", async () => {
    busy = true;
    fs.writeFileSync(runFile(), JSON.stringify({ steps: [{ key: "plugin", state: "active" }, { key: "studio", state: "pending" }] }));
    const q = queue();
    expect(await q.request("plugin", { then: ["studio"] })).toEqual({ ok: true, deferred: ["plugin", "studio"] });
    expect(ran).toEqual([]);
    expect(published.at(-1)).toEqual({ type: "update.deferred", data: { steps: ["plugin", "studio"] } });

    await q.tick();
    expect(ran).toEqual([]);
    busy = false;
    await q.tick();
    expect(ran).toEqual(["plugin", "studio"]);
    expect(q.steps()).toEqual([]);
    // The panel's run follows: the plugin done, Studio started (the daemon restarts on it).
    expect(savedRun().steps).toEqual([{ key: "plugin", state: "done" }, { key: "studio", state: "active" }]);
    expect(interrupted).toBe(0);
  });

  it("survives the daemon: a new queue picks up what waits", async () => {
    busy = true;
    await queue().request("restart");
    const next = queue();
    expect(next.steps()).toEqual(["restart"]);
    busy = false;
    await next.tick();
    expect(ran).toEqual(["restart"]);
  });

  it("Restart now ends the turns first, then runs what waits", async () => {
    busy = true;
    const q = queue();
    await q.request("studio");
    await q.runNow();
    expect(interrupted).toBe(1);
    expect(ran).toEqual(["studio"]);
    q.stop();
  });

  it("holds the rest when a turn starts while the plugin updates", async () => {
    busy = true;
    const q = new UpdateQueue({
      dataDir: dir,
      busy: () => busy,
      run: async (step) => {
        ran.push(step);
        busy = true;
        return { ok: true };
      },
      interruptTurns: () => {},
      pollMs: 60_000,
    });
    await q.request("plugin", { then: ["studio"] });
    busy = false;
    await q.tick();
    expect(ran).toEqual(["plugin"]);
    expect(q.steps()).toEqual(["studio"]);
    q.stop();
  });
});
