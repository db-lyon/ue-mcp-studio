// @vitest-environment jsdom
/**
 * Update against ue-mcp's editor consent gate: with other sessions using the
 * editor, Update asks the person who holds it and why before it closes the
 * editor, and goes on with the override (or stops) from their answer, given
 * here or on another client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import type { EditorDisruptionRequest, UpdateRun } from "@ue-mcp-studio/client-core";
import { UpdateRunner, setRunForTests, startUpdate } from "./UpdateOverlay";
import { execute } from "./update-run";

const request: EditorDisruptionRequest = {
  id: "r-1a2b",
  op: "stop",
  action: "POST /v1/editor/stop",
  requester: { id: "http:the user in Studio", label: "the user in Studio" },
  reason: "installing an update",
  state: "pending",
  createdAt: "2026-11-23T10:00:00Z",
  expiresAt: "2099-11-23T10:15:00Z",
  answers: [
    { session: "cc", label: "Claude Code", answer: "wait_until_released", reason: "busy (blueprint.add_variable)", auto: true },
    { session: "cu", label: "Cursor", answer: "go", reason: "idle for 400s", auto: true },
  ],
  self: { attestationRequired: false, attested: null, inflight: [] },
};

const pendingPlugin = (): UpdateRun => ({ steps: [{ key: "plugin", state: "pending" }], target: null, at: Date.now() });

let posts: Array<{ url: string; body: Record<string, unknown> }>;
let kept: unknown;
let hold: unknown;

beforeEach(() => {
  posts = [];
  kept = null;
  hold = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/v1/ext/studio/updates/run") {
      if (init?.method === "PUT") kept = (JSON.parse(String(init.body)) as { run: unknown }).run;
      return new Response(JSON.stringify({ run: init?.method === "PUT" ? { ok: true } : null }));
    }
    if (url === "/v1/ext/studio/updates/consent" && !init?.method) return new Response(JSON.stringify({ hold }));
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("{}");
  }));
});
afterEach(() => {
  cleanup();
  setRunForTests(null);
  vi.unstubAllGlobals();
});

let nextId = 1;
const event = (type: string, data: Record<string, unknown>) => ({ id: nextId++, type, data, time: new Date().toISOString() }) as unknown as DaemonEvent;

describe("Update with other sessions using the editor", () => {
  it("asks before anything runs, naming who holds the editor and why", async () => {
    render(<UpdateRunner streaming events={[]} />);
    const studio = { studio: { installed: "0.1.0", latest: "0.1.0", available: false }, plugin: { installed: "0.1.0", latest: "0.1.1", available: true, location: "project", engine: "5.8" } };
    await act(() => startUpdate({ studio: studio as never, ueMcp: null }, async () => request));
    expect(screen.getByRole("dialog", { name: "Update paused" })).toBeTruthy();
    expect(screen.getByText("Other sessions are using the editor")).toBeTruthy();
    expect(screen.getByText("Updating now closes the editor and interrupts those sessions' work in it.")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // Only the sessions that have not agreed are listed.
    expect(screen.queryByText("Cursor")).toBeNull();
    expect(posts.filter((p) => p.url.includes("/updates/"))).toEqual([]);
    expect((kept as UpdateRun).consent?.id).toBe("r-1a2b");
  });

  it("runs at once when nobody holds the editor", async () => {
    render(<UpdateRunner streaming events={[]} />);
    const studio = { studio: { installed: "0.1.0", latest: "0.1.0", available: false }, plugin: { installed: "0.1.0", latest: "0.1.1", available: true, location: "project", engine: "5.8" } };
    await act(() => startUpdate({ studio: studio as never, ueMcp: null }, async () => null));
    await waitFor(() => expect(posts.map((p) => p.url)).toContain("/v1/ext/studio/updates/plugin"));
    expect(posts.find((p) => p.url.endsWith("/plugin"))!.body).toEqual({ then: [] });
  });

  it("Update anyway approves the request as the person's, then runs the step with the override", async () => {
    setRunForTests({ ...pendingPlugin(), consent: request });
    render(<UpdateRunner streaming events={[]} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update anyway" })));
    await waitFor(() => expect(posts.map((p) => p.url)).toContain("/v1/ext/studio/updates/plugin"));
    expect(posts[0]).toEqual({ url: "/v1/disruptions/r-1a2b/approve", body: { by: "the user in Studio" } });
    expect(posts.find((p) => p.url.endsWith("/plugin"))!.body).toEqual({ then: [], force: true });
  });

  it("Cancel denies the request and ends the run without running anything", async () => {
    setRunForTests({ ...pendingPlugin(), consent: request });
    render(<UpdateRunner streaming events={[]} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(posts).toEqual([{ url: "/v1/disruptions/r-1a2b/deny", body: { by: "the user in Studio" } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(kept).toBeNull());
  });

  it("goes on when the request is approved from another client, and stops when it is denied there", async () => {
    setRunForTests({ ...pendingPlugin(), consent: request });
    const { rerender } = render(<UpdateRunner streaming events={[]} />);
    rerender(<UpdateRunner streaming events={[event("studio.update.consent", { hold: null, decided: "approve" })]} />);
    await waitFor(() => expect(posts.find((p) => p.url.endsWith("/plugin"))?.body).toEqual({ then: [], force: true }));
    expect(posts.some((p) => p.url.endsWith("/approve"))).toBe(false);

    cleanup();
    posts = [];
    setRunForTests({ ...pendingPlugin(), consent: request });
    const second = render(<UpdateRunner streaming events={[]} />);
    second.rerender(<UpdateRunner streaming events={[event("studio.update.consent", { hold: null, decided: "deny" })]} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([]);
  });

  it("says why it stopped when nobody answered in time", async () => {
    setRunForTests({ ...pendingPlugin(), consent: request });
    const { rerender } = render(<UpdateRunner streaming events={[]} />);
    rerender(<UpdateRunner streaming events={[event("studio.update.consent", { hold: null, decided: "expired" })]} />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Update stopped" })).toBeTruthy());
    expect(screen.getByText("The request to close the editor expired before anyone approved it, so the update stopped before closing the editor.")).toBeTruthy();
  });

  it("shows a step held while waiting for turns, which the agent runs, and answers it through the override routes", async () => {
    const { rerender } = render(<UpdateRunner streaming events={[]} />);
    rerender(<UpdateRunner streaming events={[event("studio.update.consent", { hold: { request, source: "queue" } })]} />);
    expect(screen.getByText("Other sessions are using the editor")).toBeTruthy();
    // A banner, not a dialog: the agent runs the step, and nothing here takes the screen.
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update anyway" })));
    expect(posts).toEqual([{ url: "/v1/disruptions/r-1a2b/approve", body: { by: "the user in Studio" } }]);
  });
});

describe("a step the gate holds mid-run", () => {
  it("keeps the run on the request, with the step pending again, instead of failing it", async () => {
    let last: UpdateRun | null = null;
    const run: UpdateRun = { steps: [{ key: "ueMcp", state: "done" }, { key: "plugin", state: "pending" }, { key: "studio", state: "pending" }], target: "1.4.1", at: Date.now() };
    await execute(run, (r) => void (last = r), async (url) => (url.endsWith("/plugin") ? { ok: false, error: "Claude Code is busy", request } : { ok: true }));
    expect(last!.consent?.id).toBe("r-1a2b");
    expect(last!.error).toBeUndefined();
    expect(last!.steps.map((s) => s.state)).toEqual(["done", "pending", "pending"]);
  });

  it("carries the person's override on every step of a forced run", async () => {
    const bodies: unknown[] = [];
    const run: UpdateRun = { steps: [{ key: "ueMcp", state: "pending" }, { key: "plugin", state: "pending" }], target: "1.4.1", at: Date.now(), force: true };
    await execute(run, () => {}, async (_url, body) => (bodies.push(body), { ok: true }));
    expect(bodies).toEqual([{ version: "1.4.1", force: true }, { then: [], force: true }]);
  });
});
