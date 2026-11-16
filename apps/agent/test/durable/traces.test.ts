/**
 * The durable runtime's traces: Pi Durable's phases and pi-ai's model
 * requests, recorded in the project's durable folder and read back through
 * the harness, by Studio session.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHarness } from "../../src/durable/harness-main.js";
import { telemetryFile } from "../../src/durable/protocol.js";
import { traceFilterOf } from "../../src/durable/routes.js";
import { durableRunner, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

let dir: string;
let fake: FakeAnthropic | undefined;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-traces-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  harness = null;
  fake = undefined;
  rig = undefined;
});

afterEach(async () => {
  rig?.runner.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const start = async (launch: Parameters<typeof runHarness>[0]) => {
  harness = await runHarness(launch);
};

describe("durable runtime traces", () => {
  it("says nothing is running before the first reply, without starting a runtime", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Hi." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const seen = await rig.runner.durableTraces({});
    expect(seen.running).toBe(false);
    expect(harness).toBeNull();
  });

  it("records a reply's model request with its tokens under its session, and reads one trace whole", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Traced." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    const other = rig.store.create("other");
    await rig.runner.send(s.id, "hello");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    expect(fs.existsSync(telemetryFile(path.join(dir, "data")))).toBe(true);

    // A span is stored once it settles; the read writes what is buffered first.
    let page: Awaited<ReturnType<NonNullable<typeof rig>["runner"]["durableTraces"]>> | undefined;
    // The user's message starts the trace; the run's phases and its model request are spans under it.
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      page = await rig.runner.durableTraces({ filter: { name: "pi.durable.submit" } });
      if (page.running && "traces" in page && page.traces.some((t) => t.tokens)) break;
    }
    if (!page?.running || !("traces" in page)) throw new Error("no page");
    const req = page.traces.find((t) => t.tokens);
    if (!req) throw new Error("no trace with a model request");
    expect(req.name).toBe("pi.durable.submit");
    expect(req.errors).toBe(0);
    expect(req.sessionId).toBe(s.id);
    expect(req.parent).toBeNull();
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.tokens?.output ?? 0).toBeGreaterThan(0);
    expect(req.cost ?? 0).toBeGreaterThan(0);
    expect(req.durationMs).toBeGreaterThan(0);

    // Every trace of the reply, then only its session's: the other session never ran.
    const all = await rig.runner.durableTraces({ filter: { limit: 100 } });
    expect(all.running && "traces" in all && all.traces.length).toBeGreaterThan(0);
    const mine = await rig.runner.durableTraces({ filter: { sessionId: s.id, limit: 100 } });
    expect(mine.running && "traces" in mine && mine.traces.length).toBeGreaterThan(0);
    if (mine.running && "traces" in mine) for (const t of mine.traces) expect(t.sessionId).toBe(s.id);
    const none = await rig.runner.durableTraces({ filter: { sessionId: other.id } });
    expect(none.running && "traces" in none && none.traces).toEqual([]);

    const one = await rig.runner.durableTraces({ traceId: req.traceId });
    if (!one.running || !("trace" in one) || !one.trace) throw new Error("no trace");
    expect(one.trace.summary.traceId).toBe(req.traceId);
    expect(one.trace.spans.map((x) => x.name)).toContain("pi.ai.request");
    expect(one.trace.rendered).toContain("pi.ai.request");

    const missing = await rig.runner.durableTraces({ traceId: "0".repeat(32) });
    expect(missing.running && "trace" in missing && missing.trace).toBeNull();
  }, 60_000);

  it("says how to go on when the running runtime is from an older Studio and keeps no traces", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Hi." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "hello");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const client = (rig.runner as unknown as { durable: { client: { harness: { features: string[] } } } }).durable.client;
    client.harness.features = client.harness.features.filter((f) => f !== "traces");
    await expect(rig.runner.durableTraces({})).rejects.toThrow(/keeps no traces\. It is replaced by this Studio's/);
  }, 60_000);
});

describe("traces query string", () => {
  it("keeps known values and clamps the limit", () => {
    expect(traceFilterOf({ name: "pi.ai.request", errors: "1", session: "abc", since: "5", limit: "500", cursor: "c" })).toEqual({ name: "pi.ai.request", errors: true, sessionId: "abc", since: 5, limit: 100, cursor: "c" });
    expect(traceFilterOf({ errors: "no", since: "x", limit: "0" })).toEqual({ limit: 1 });
    expect(traceFilterOf({})).toEqual({});
  });
});
