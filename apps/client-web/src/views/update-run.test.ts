// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, loadRun, planRun, saveRun, settle, type UpdateRun } from "./update-run";

const studio = (s: boolean, p: boolean) => ({
  studio: { installed: s ? "0.1.0-beta.9" : "0.1.0-beta.10", latest: "0.1.0-beta.10", available: s },
  plugin: { installed: p ? "0.1.0-beta.4" : "0.1.0-beta.9", latest: "0.1.0-beta.9", available: p, location: "project" as const, engine: "5.8" },
});
const ueMcp = (server: string, target: string | null) => ({ server, latest: "1.4.0-beta.4", target, binaries: null });

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("an update run", () => {
  it("restarts ue-mcp when Studio does not, since Studio's own update restarts it", () => {
    expect(planRun({ studio: studio(true, true), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") })!.steps.map((s) => s.key)).toEqual(["ueMcp", "plugin", "studio"]);
    expect(planRun({ studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") })!.steps.map((s) => s.key)).toEqual(["ueMcp", "restart"]);
    expect(planRun({ studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.4", null) })).toBeNull();
  });

  it("keeps going after the editor restarts for the plugin: the plugin is done, Studio still to do", () => {
    const run: UpdateRun = { target: null, at: Date.now(), steps: [{ key: "plugin", state: "active" }, { key: "studio", state: "pending" }] };
    expect(settle(run, { studio: studio(true, false), ueMcp: ueMcp("1.4.0-beta.4", null) }).steps.map((s) => s.state)).toEqual(["done", "pending"]);
  });

  it("says a step did not finish when the updates still offer it", () => {
    const run: UpdateRun = { target: "1.4.0-beta.4", at: Date.now(), steps: [{ key: "ueMcp", state: "done" }, { key: "restart", state: "active" }] };
    const next = settle(run, { studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") });
    expect(next.steps[1].state).toBe("failed");
    expect(next.error).toMatch(/Restart ue-mcp did not finish/);
    expect(settle(run, { studio: studio(false, false), ueMcp: ueMcp("1.4.0-beta.4", null) }).steps[1].state).toBe("done");
  });

  it("drops a run left from long ago", () => {
    saveRun({ target: null, at: 0, steps: [] });
    expect(loadRun(31 * 60_000)).toBeNull();
    expect(loadRun(60_000)).not.toBeNull();
  });

  it("hands over to the next page at a step that takes ue-mcp down, with the run saved", async () => {
    const sent: string[] = [];
    const seen: string[][] = [];
    const run = planRun({ studio: studio(true, true), ueMcp: ueMcp("1.4.0-beta.3", "1.4.0-beta.4") })!;
    await execute(run, (r) => seen.push(r.steps.map((s) => s.state)), async (url) => (sent.push(url), { ok: true }));
    expect(sent).toEqual(["/v1/update/apply", "/v1/ext/studio/updates/plugin", "/v1/ext/studio/updates/studio"]);
    expect(seen[seen.length - 1]).toEqual(["done", "done", "active"]);
    expect(loadRun()!.steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
  });

  it("finishes with what is installed now, and forgets the run", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/ext/studio/") ? studio(false, false) : ueMcp("1.4.0-beta.4", null)))));
    let last: UpdateRun | null = null;
    await execute({ target: null, at: Date.now(), steps: [{ key: "plugin", state: "pending" }] }, (r) => (last = r), async () => ({ ok: true }));
    expect(last!.summary).toBe("Studio 0.1.0-beta.10, editor plugin 0.1.0-beta.9, ue-mcp 1.4.0-beta.4.");
    expect(loadRun()).toBeNull();
  });
});
