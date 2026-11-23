import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOLD_EXPIRED, UpdateQueue, type DeferredStep } from "../src/update-queue.js";

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

describe("turns that run in host processes", () => {
  // busy: a turn runs; pinned: one runs inside the daemon, which a restart would end.
  let pinned: boolean;
  const hostedQueue = () =>
    new UpdateQueue({
      dataDir: dir,
      busy: () => busy,
      pinned: () => pinned,
      run: async (step) => {
        ran.push(step);
        return { ok: true, started: step !== "plugin" };
      },
      interruptTurns: () => void interrupted++,
      pollMs: 60_000,
    });

  it("let Studio and the restart run at once, ending nothing, while the plugin waits for them", async () => {
    busy = true;
    pinned = false;
    const q = hostedQueue();
    expect(await q.request("studio")).toMatchObject({ ok: true, started: true });
    expect(await q.request("restart")).toMatchObject({ ok: true, started: true });
    expect(await q.request("plugin")).toEqual({ ok: true, deferred: ["plugin"] });
    expect(ran).toEqual(["studio", "restart"]);
    expect(interrupted).toBe(0);
    q.stop();
  });

  it("holds Studio, but not the restart, while a turn runs in a turn host the next Studio cannot take over", async () => {
    busy = true;
    pinned = false;
    let hosted = true;
    const q = new UpdateQueue({
      dataDir: dir,
      busy: () => busy,
      pinned: () => pinned,
      hosted: () => hosted,
      run: async (step) => {
        ran.push(step);
        return { ok: true, started: step !== "plugin" };
      },
      interruptTurns: () => void interrupted++,
      pollMs: 60_000,
    });
    expect(await q.request("restart")).toMatchObject({ ok: true, started: true });
    expect(await q.request("studio")).toEqual({ ok: true, deferred: ["studio"] });
    await q.tick();
    expect(ran).toEqual(["restart"]);
    hosted = false;
    await q.tick();
    expect(ran).toEqual(["restart", "studio"]);
    expect(interrupted).toBe(0);
    q.stop();
  });

  it("a waiting Studio step runs once only hosted turns are left", async () => {
    busy = true;
    pinned = true;
    const q = hostedQueue();
    expect(await q.request("studio")).toEqual({ ok: true, deferred: ["studio"] });
    await q.tick();
    expect(ran).toEqual([]);
    pinned = false;
    await q.tick();
    expect(ran).toEqual(["studio"]);
    expect(interrupted).toBe(0);
    q.stop();
  });
});

describe("a waiting step the editor consent gate holds", () => {
  const request = { id: "r-77", op: "stop", state: "pending", requester: { id: "http:the user in Studio", label: "the user in Studio" }, answers: [] } as never;
  let consents: Array<{ step: DeferredStep; force?: boolean }>;
  let holding: boolean;
  let held: unknown[];
  const gated = () =>
    new UpdateQueue({
      dataDir: dir,
      busy: () => busy,
      run: async (step, consent) => {
        consents.push({ step, ...consent });
        if (step === "plugin" && holding && !consent.force) return { ok: false, error: "Claude Code is busy", request };
        ran.push(step);
        return { ok: true, started: step !== "plugin" };
      },
      held: (r) => held.push(r),
      interruptTurns: () => undefined,
      publish: (type, data) => published.push({ type, data }),
      pollMs: 60_000,
    });

  beforeEach(() => {
    consents = [];
    holding = true;
    held = [];
    busy = true;
    fs.writeFileSync(runFile(), JSON.stringify({ steps: [{ key: "plugin", state: "pending" }, { key: "studio", state: "pending" }] }));
  });

  it("keeps the steps, held on the request, and asks the person instead of failing the run", async () => {
    const q = gated();
    await q.request("plugin", { then: ["studio"] });
    busy = false;
    await q.tick();
    expect(held).toEqual([request]);
    expect(ran).toEqual([]);
    expect(q.steps()).toEqual(["plugin", "studio"]);
    expect(q.heldOn()).toBe("r-77");
    expect(savedRun().steps[0]).toEqual({ key: "plugin", state: "deferred" });
    // Nothing runs again by itself while the person decides.
    await q.tick();
    expect(consents).toHaveLength(1);
    q.stop();
  });

  it("runs every step with the override once the request is approved", async () => {
    const q = gated();
    await q.request("plugin", { then: ["studio"] });
    busy = false;
    await q.tick();
    await q.decide("approve");
    expect(ran).toEqual(["plugin", "studio"]);
    expect(consents.slice(1)).toEqual([{ step: "plugin", force: true }, { step: "studio", force: true }]);
    expect(q.steps()).toEqual([]);
    q.stop();
  });

  it("drops the steps and the run when the request is denied", async () => {
    const q = gated();
    await q.request("plugin", { then: ["studio"] });
    busy = false;
    await q.tick();
    await q.decide("deny");
    expect(ran).toEqual([]);
    expect(q.steps()).toEqual([]);
    expect(fs.existsSync(runFile())).toBe(false);
    expect(published.at(-1)).toEqual({ type: "update.run", data: { run: null } });
  });

  it("stops the run with why when nobody answered in time", async () => {
    const q = gated();
    await q.request("plugin", { then: ["studio"] });
    busy = false;
    await q.tick();
    await q.decide("expired");
    expect(q.steps()).toEqual([]);
    expect(savedRun()).toMatchObject({ error: HOLD_EXPIRED, steps: [{ key: "plugin", state: "failed" }, { key: "studio", state: "pending" }] });
  });

  it("keeps the person's Update anyway with steps that wait for a turn", async () => {
    const q = gated();
    expect(await q.request("plugin", { then: ["studio"], force: true })).toMatchObject({ deferred: ["plugin", "studio"] });
    busy = false;
    await q.tick();
    expect(held).toEqual([]);
    expect(ran).toEqual(["plugin", "studio"]);
    expect(consents).toEqual([{ step: "plugin", force: true }, { step: "studio", force: true }]);
  });

  it("runs a step that nothing waits on with the override it was given", async () => {
    busy = false;
    const q = gated();
    expect(await q.request("plugin", { force: true })).toMatchObject({ ok: true });
    expect(consents).toEqual([{ step: "plugin", force: true }]);
    holding = true;
    expect(await q.request("plugin")).toMatchObject({ ok: false, request });
    q.stop();
  });
});
