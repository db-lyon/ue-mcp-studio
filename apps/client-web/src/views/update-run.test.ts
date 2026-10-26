// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { afterRunning, execute, loadRun, planRun, restartNow, saveRun, settle, waitingSteps, type UpdateRun } from "./update-run";

const studio = (s: boolean, p: boolean) => ({
  studio: { installed: s ? "0.1.0-beta.9" : "0.1.0-beta.10", latest: "0.1.0-beta.10", available: s },
  plugin: { installed: p ? "0.1.0-beta.4" : "0.1.0-beta.9", latest: "0.1.0-beta.9", available: p, location: "project" as const, engine: "5.8" },
});
const ueMcp = (server: string, target: string | null) => ({ installed: { version: server }, server, latest: "1.4.0-beta.4", target, binaries: null });

/** The agent's run store, and the update reads, behind fetch. */
function agent(updates: () => unknown) {
  const kept: { run: unknown } = { run: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/v1/ext/studio/updates/run") {
      if (init?.method === "PUT") kept.run = (JSON.parse(String(init.body)) as { run: unknown }).run;
      return new Response(JSON.stringify({ run: kept.run }));
    }
    return new Response(JSON.stringify(updates()));
  }));
  return kept;
}

afterEach(() => vi.unstubAllGlobals());

describe("an update run", () => {
  it("restarts ue-mcp when Studio does not, since Studio's own update restarts it", () => {
    expect(planRun({ studio: studio(true, true), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") })!.steps.map((s) => s.key)).toEqual(["ueMcp", "plugin", "studio"]);
    expect(planRun({ studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") })!.steps.map((s) => s.key)).toEqual(["ueMcp", "restart"]);
    expect(planRun({ studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.4", null) })).toBeNull();
  });

  it("installs at least the ue-mcp the latest Studio needs before Studio, whatever the channel", () => {
    const needs = { ...studio(true, false), ueMcpMin: "1.4.11-beta.6" };
    // Stable channel: nothing newer on latest, yet the floor is a beta.
    const run = planRun({ studio: needs, ueMcp: ueMcp("1.4.10", null) })!;
    expect(run.steps.map((s) => s.key)).toEqual(["ueMcp", "studio"]);
    expect(run.target).toBe("1.4.11-beta.6");
    // A channel target past the floor is kept.
    expect(planRun({ studio: needs, ueMcp: ueMcp("1.4.10", "1.4.11") })!.target).toBe("1.4.11");
    // A channel target below the floor is raised to it.
    expect(planRun({ studio: needs, ueMcp: ueMcp("1.4.10", "1.4.11-beta.2") })!.target).toBe("1.4.11-beta.6");
    // A daemon on the floor already: the channel decides.
    expect(planRun({ studio: needs, ueMcp: ueMcp("1.4.11-beta.6", null) })!.steps.map((s) => s.key)).toEqual(["studio"]);
  });

  it("updates only the bridge when the daemon already runs its target", () => {
    const behind = { installed: { version: "1.4.0-beta.1" }, server: "1.4.3", latest: "1.4.3", target: "1.4.3", binaries: null };
    const run = planRun({ studio: studio(false, false), ueMcp: behind })!;
    expect(run.steps.map((s) => s.key)).toEqual(["ueMcp"]);
    expect(run.target).toBe("1.4.3");
  });

  it("never plans the plugin step for a Fab install, which the Fab Library updates", () => {
    const fab = { ...studio(true, true), plugin: { ...studio(true, true).plugin, source: "fab" as const } };
    expect(planRun({ studio: fab, ueMcp: ueMcp("1.4.0-beta.4", null) })!.steps.map((s) => s.key)).toEqual(["studio"]);
    const run: UpdateRun = { target: null, at: Date.now(), steps: [{ key: "studio", state: "active" }] };
    expect(settle(run, { studio: { ...fab, studio: { ...fab.studio, available: false } }, ueMcp: ueMcp("1.4.0-beta.4", null) }).steps).toEqual([{ key: "studio", state: "done" }]);
  });

  it("keeps going after the editor restarts for the plugin: the plugin is done, Studio still to do", () => {
    const run: UpdateRun = { target: null, at: Date.now(), steps: [{ key: "plugin", state: "active" }, { key: "studio", state: "pending" }] };
    expect(settle(run, { studio: studio(true, false), ueMcp: ueMcp("1.4.0-beta.4", null) }).steps.map((s) => s.state)).toEqual(["done", "pending"]);
  });

  it("does not take a failed check for a finished step", () => {
    const run: UpdateRun = { target: null, at: Date.now(), steps: [{ key: "plugin", state: "active" }, { key: "studio", state: "pending" }] };
    const failedCheck = { ...studio(true, false), error: "GitHub answered 403 for db-lyon/ue-mcp-studio-plugin's releases" };
    const next = settle(run, { studio: failedCheck, ueMcp: ueMcp("1.4.0-beta.4", null) });
    expect(next.steps.map((s) => s.state)).toEqual(["failed", "pending"]);
    expect(next.error).toBeTruthy();
  });

  it("waits while the agent is still swapping the plugin", async () => {
    let reads = 0;
    const u = await afterRunning(async () => ({ studio: { ...studio(true, false), ...(++reads < 3 ? { running: "plugin" } : {}) }, ueMcp: null }), 1);
    expect(reads).toBe(3);
    expect(u.studio?.running).toBeUndefined();
  });

  it("goes on to a plugin update the new Studio found after it reloaded", () => {
    const run: UpdateRun = { target: null, at: Date.now(), steps: [{ key: "studio", state: "active" }] };
    expect(settle(run, { studio: studio(false, true), ueMcp: ueMcp("1.4.0-beta.4", null) }).steps).toEqual([{ key: "studio", state: "done" }, { key: "plugin", state: "pending" }]);
  });

  it("says a step did not finish when the updates still offer it", () => {
    const run: UpdateRun = { target: "1.4.0-beta.4", at: Date.now(), steps: [{ key: "ueMcp", state: "done" }, { key: "restart", state: "active" }] };
    const next = settle(run, { studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") });
    expect(next.steps[1].state).toBe("failed");
    expect(next.error).toBe("ue-mcp is still 1.4.0-beta.3; 1.4.0-beta.4 did not install. Update tries again.");
    expect(settle(run, { studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.4", null) }).steps[1].state).toBe("done");
  });

  it("drops a run left from long ago", async () => {
    agent(() => ({}));
    await saveRun({ target: null, at: 0, steps: [] });
    expect(await loadRun(31 * 60_000)).toBeNull();
    expect(await loadRun(60_000)).not.toBeNull();
  });

  it("hands over to the next page at a step that takes ue-mcp down, with the run saved", async () => {
    agent(() => ({}));
    const sent: string[] = [];
    const seen: string[][] = [];
    const run = planRun({ studio: studio(true, true), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") })!;
    await execute(run, (r) => seen.push(r.steps.map((s) => s.state)), async (url) => (sent.push(url), { ok: true }));
    expect(sent).toEqual(["/v1/update/apply", "/v1/ext/studio/updates/plugin", "/v1/ext/studio/updates/studio"]);
    expect(seen[seen.length - 1]).toEqual(["done", "done", "active"]);
    expect((await loadRun())!.steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
  });

  it("updates a bridge installed from source through the new package instead of failing", async () => {
    agent(() => ({}));
    const sent: Array<[string, unknown]> = [];
    const run = planRun({ studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.3", "1.4.1") })!;
    let last: UpdateRun | null = null;
    await execute(run, (r) => (last = r), async (url, body) => {
      sent.push([url, body]);
      return url === "/v1/update/apply"
        ? { ok: false, error: "this process runs ue-mcp 1.4.0-beta.3; a source install updates to the version of the package that deploys it. Run ue-mcp update." }
        : { ok: true };
    });
    expect(sent).toEqual([
      ["/v1/update/apply", { version: "1.4.1" }],
      ["/v1/ext/studio/updates/ueMcp", { version: "1.4.1" }],
      ["/v1/ext/studio/updates/restart", { then: [] }],
    ]);
    expect(last!.error).toBeUndefined();
  });

  it("finishes with what is installed now, and forgets the run", async () => {
    agent(() => ({}));
    const reads = fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = reads.getMockImplementation()!;
    reads.mockImplementation(async (url: string, init?: RequestInit) =>
      url === "/v1/ext/studio/updates/run" ? inner(url, init) : new Response(JSON.stringify(url.includes("/ext/studio/") ? studio(false, false) : ueMcp("1.4.0-beta.4", null))));
    let last: UpdateRun | null = null;
    await execute({ target: null, at: Date.now(), steps: [{ key: "plugin", state: "pending" }] }, (r) => (last = r), async () => ({ ok: true }));
    expect(last!.summary).toBe("Studio 0.1.0-beta.10, editor plugin 0.1.0-beta.9, bridge plugin 1.4.0-beta.4, ue-mcp 1.4.0-beta.4.");
    expect(await loadRun()).toBeNull();
  });

  it("hands the rest to the agent when a turn is in progress, and keeps that run however long the turn takes", async () => {
    agent(() => ({}));
    const sent: Array<[string, unknown]> = [];
    let last: UpdateRun | null = null;
    const run = planRun({ studio: studio(true, true), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") })!;
    await execute(run, (r) => (last = r), async (url, body) => {
      sent.push([url, body]);
      return url.endsWith("/plugin") ? { ok: true, deferred: ["plugin", "studio"] } : { ok: true };
    });
    expect(sent).toEqual([["/v1/update/apply", { version: "1.4.0-beta.4" }], ["/v1/ext/studio/updates/plugin", { then: ["studio"] }]]);
    expect(last!.steps.map((s) => s.state)).toEqual(["done", "deferred", "deferred"]);
    expect(waitingSteps(last!)).toEqual(["plugin", "studio"]);
    const kept = (await loadRun(Date.now() + 3 * 3600_000))!;
    expect(kept.steps.map((s) => s.state)).toEqual(["done", "deferred", "deferred"]);
    // A page that loads meanwhile shows the wait rather than running anything.
    const again: string[] = [];
    await execute(kept, () => {}, async (url) => (again.push(url), { ok: true }));
    expect(again).toEqual([]);
  });

  it("Restart now asks the agent to run the waiting steps", async () => {
    agent(() => ({}));
    const sent: string[] = [];
    const seen: UpdateRun[] = [];
    const run: UpdateRun = { target: null, at: Date.now(), steps: [{ key: "studio", state: "deferred" }] };
    await restartNow(run, (r) => seen.push(r), async (url) => (sent.push(url), { ok: true }));
    expect(sent).toEqual(["/v1/ext/studio/updates/deferred/now"]);
    expect(seen[0].steps).toEqual([{ key: "studio", state: "active" }]);
  });
});
