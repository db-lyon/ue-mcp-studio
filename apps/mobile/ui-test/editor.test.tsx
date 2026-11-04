import { describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createLock, studioApi, type Reply, type Transport } from "@ue-mcp-studio/client-core";
import { EditorBanner, EditorChip } from "../src/screens/editor/EditorChip";
import { EditorStatus } from "../src/screens/editor/EditorStatus";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

const health = (connected: boolean, lastDisconnect: { cause: string; at: string } | null = null) => ({
  version: "1.4.11", apiVersion: 1, pid: 4120, startedAt: "2026-11-04T10:00:00Z", clients: 2, inflight: 1, ui: "0.1.25", projectRoot: "C:/P/StudioE2E",
  extensions: [{ name: "studio", version: "0.1.25" }],
  editors: [{ name: "StudioE2E", connected, port: 9877, pid: connected ? 22816 : null, lastDisconnect }],
});
const call = (id: number, over: Record<string, unknown> = {}) => ({ id, category: "blueprint", action: "compile_blueprint", startedAt: Date.now() - 12_000, source: "studio", stopped: false, ...over });

function api(busy: Record<string, unknown>, connected = true) {
  const a = fakeApi();
  a.busy.mockResolvedValue({ now: Date.now(), calls: [], ...busy });
  a.daemonHealth.mockResolvedValue(health(connected));
  return a;
}

describe("EditorChip", () => {
  it("shows nothing while the editor is connected and idle", async () => {
    renderInProject(<EditorChip />, api({}));
    await settle();
    expect(screen.queryByTestId("editor-chip")).toBeNull();
  });

  it("says the editor is off, opens the banner and starts it", async () => {
    const a = api({}, false);
    a.editor.mockResolvedValue({ steps: [{ step: "start", ok: true }] });
    renderInProject(<EditorChip />, a);
    await settle();
    expect(screen.getByText("Editor off")).toBeTruthy();
    fireEvent.click(screen.getByTestId("editor-chip"));
    expect(screen.getByText("Editor not running")).toBeTruthy();
    fireEvent.click(screen.getByText("Start"));
    expect(a.editor).toHaveBeenCalledWith("start");
    await settle();
  });

  it("says why a start failed", async () => {
    const a = api({}, false);
    a.editor.mockResolvedValue({ steps: [{ step: "start", ok: false, result: "No editor executable found." }] });
    renderInProject(<EditorChip />, a);
    await settle();
    fireEvent.click(screen.getByTestId("editor-chip"));
    fireEvent.click(screen.getByText("Start"));
    await settle();
    expect(screen.getByText(/No editor executable found\./)).toBeTruthy();
  });

  it("names a failed restart's step and reason", async () => {
    renderInProject(<EditorChip />, api({ failure: { op: "restart", step: "connect", reason: "It never connected.", at: Date.now() } }, false));
    await settle();
    fireEvent.click(screen.getByTestId("editor-chip"));
    expect(screen.getByText("The restart did not bring the editor back (waiting for the editor to connect).")).toBeTruthy();
    expect(screen.getByText(/It never connected\./)).toBeTruthy();
  });

  it("counts an operation's time and step, with no Start", async () => {
    renderInProject(<EditorChip />, api({ operation: { op: "rebuild", step: "project.build", startedAt: Date.now() - 83_000, stepStartedAt: Date.now() } }, false));
    await settle();
    expect(screen.getByText("Rebuilding 1:23")).toBeTruthy();
    fireEvent.click(screen.getByTestId("editor-chip"));
    expect(screen.getByText("Rebuilding the project:")).toBeTruthy();
    expect(screen.getByText(/building the C\+\+ \(step 2 of 3\)/)).toBeTruthy();
    expect(screen.queryByText("Start")).toBeNull();
  });

  it("stops Studio's busy call and says how many more wait", async () => {
    const a = api({ calls: [call(1), call(2, { category: "level", action: "spawn_actor" })] });
    a.stopBusy.mockResolvedValue({ stopped: ["1"] });
    renderInProject(<EditorChip />, a);
    await settle();
    expect(screen.getByText(/^Editor busy 0:1\d$/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("editor-chip"));
    expect(screen.getByText(/blueprint\(compile_blueprint\)/)).toBeTruthy();
    expect(screen.getByText(/and 1 more/)).toBeTruthy();
    fireEvent.click(screen.getByText("Stop"));
    expect(a.stopBusy).toHaveBeenCalled();
    await settle();
  });

  it("offers no Stop for another client's call, and names the client", async () => {
    renderInProject(<EditorChip />, api({ calls: [call(3, { source: "client", client: "Cursor" })] }));
    await settle();
    fireEvent.click(screen.getByTestId("editor-chip"));
    expect(screen.getByText(/from Cursor/)).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
  });

  it("says Stopped while the editor finishes a stopped call", async () => {
    renderInProject(<EditorChip />, api({ calls: [call(1, { stopped: true })] }));
    await settle();
    expect(screen.getByText(/^Stopping /)).toBeTruthy();
    fireEvent.click(screen.getByTestId("editor-chip"));
    expect(screen.getByText("Stopped.")).toBeTruthy();
    expect(screen.getByText(/The editor is finishing blueprint\(compile_blueprint\)\./)).toBeTruthy();
  });

  it("follows studio.busy.changed", async () => {
    const { project, emit } = fakeProject();
    renderInProject(<EditorBanner />, api({}), project);
    await settle();
    expect(screen.queryByTestId("editor-banner")).toBeNull();
    emit("studio.busy.changed", { now: Date.now(), calls: [call(5)] });
    expect(screen.getByText("Editor busy:")).toBeTruthy();
  });
});

describe("EditorStatus", () => {
  it("lists the editor and offers what its state allows", async () => {
    const a = fakeApi();
    a.daemonHealth.mockResolvedValue(health(true));
    a.editor.mockResolvedValue({ steps: [{ step: "editor.restart_editor", ok: true }, { step: "connect", ok: false }] });
    renderInProject(<EditorStatus />, a);
    await settle();
    expect(screen.getByText("StudioE2E")).toBeTruthy();
    expect(screen.getByText("port 9877, pid 22816")).toBeTruthy();
    expect(screen.getByText("Start").closest("[aria-disabled]")?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("C:/P/StudioE2E")).toBeTruthy();
    expect(screen.getByText("studio 0.1.25")).toBeTruthy();
    fireEvent.click(screen.getByText("Restart"));
    expect(a.editor).toHaveBeenCalledWith("restart");
    expect(screen.getByText("restart...")).toBeTruthy();
    await settle();
    expect(screen.getByText("editor.restart_editor: ok, connect: failed")).toBeTruthy();
  });

  it("says how a disconnected editor dropped and offers only Start", async () => {
    const a = fakeApi();
    a.daemonHealth.mockResolvedValue(health(false, { cause: "crashed", at: "2026-11-04T12:00:00Z" }));
    renderInProject(<EditorStatus />, a);
    await settle();
    expect(screen.getByText(/^crashed at /)).toBeTruthy();
    for (const op of ["Stop", "Restart", "Rebuild"]) expect(screen.getByText(op).closest("[aria-disabled]")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("says when the daemon cannot be read yet", () => {
    renderInProject(<EditorStatus />);
    expect(screen.getByText("Connecting to the daemon...")).toBeTruthy();
  });

  it("asks for the PIN before a restart, then sends it", async () => {
    const enc = new TextEncoder();
    const reply = (status: number, body: unknown): Reply => ({ status, headers: { "content-type": "application/json" }, body: (async function* () { yield enc.encode(JSON.stringify(body)); })() });
    const sent: string[] = [];
    let unlocked = false;
    const raw: Transport = async (method, path) => {
      sent.push(`${method} ${path}`);
      if (path === "/v1/editor/restart") return unlocked ? reply(200, { steps: [{ step: "editor.restart_editor", ok: true }] }) : reply(423, { code: "pin-required", error: "Enter your PIN." });
      if (path === "/v1/ext/studio/lock/unlock") return (unlocked = true), reply(200, { whole: false, sensitive: true, locked: false, sensitiveOpen: true, idleMinutes: 15 });
      if (path === "/v1/ext/studio/lock") return reply(200, { whole: false, sensitive: true, locked: false, sensitiveOpen: false, idleMinutes: 15 });
      return reply(404, {});
    };
    const lock = createLock(raw);
    const guarded = lock.guard(raw);
    const project = { ...fakeProject(guarded).project, lock };
    const a = { ...studioApi(guarded), daemonHealth: async () => health(true) };
    renderInProject(<EditorStatus />, a as never, project);
    await settle();
    fireEvent.click(screen.getByText("Restart"));
    await settle();
    expect(lock.view().prompt).toBe(true);
    expect(screen.queryByText(/editor.restart_editor: ok/)).toBeNull();
    await act(async () => void (await lock.unlock("1234")));
    await settle();
    expect(sent.filter((s) => s === "POST /v1/editor/restart")).toHaveLength(2);
    expect(screen.getByText("editor.restart_editor: ok")).toBeTruthy();
  });
});
