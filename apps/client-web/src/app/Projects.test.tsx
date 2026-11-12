// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { appSlot, type HostState, type Newest } from "./native";
import type { MachineProject, MachineReport } from "./model";
import { resetWork, WATCH_UPDATE } from "./actions";

const STATE: HostState = {
  mode: "app", version: "0.1.35", node: { found: true, version: "v22.11.0", ok: true, min: 20 }, winget: true, channel: "latest",
  installDir: "C:\\Apps\\UE-MCP", installed: { version: "0.1.35", dir: "C:\\Apps\\UE-MCP" }, compare: "same",
};

function project(n: number, name: string, dir: string, o: Partial<MachineProject> = {}): MachineProject {
  const key = String(n).padStart(16, "a");
  return {
    name, uproject: `${dir}\\${name}.uproject`, dir, key, source: "recent", lastOpened: null,
    engine: { association: "5.7", version: "5.7" }, editor: { running: false, pids: [] },
    ueMcp: { setUp: true, bridge: { version: "1.4.13", kind: "binary" }, config: true },
    extensions: {}, plugins: [], daemon: { discovery: "", log: "", running: null }, ...o,
  };
}

const withStudio = project(1, "ue_mcp", "C:\\work\\ue-mcp\\tests\\ue_mcp", { extensions: { studio: "0.1.34" }, plugins: [{ name: "UE_MCP_Studio", version: "0.1.8" }] });
const bare = project(2, "ue_mcp", "C:\\work\\ue-mcp-release\\tests\\ue_mcp");

function fakeHost(o: { newest?: Newest; live?: Record<string, { pid: number; port: number; version: string }>; health?: string; reports?: MachineProject[][] } = {}) {
  const reports = o.reports ?? [[withStudio, bare]];
  let read = 0;
  const app = {
    getstate: vi.fn(async () => STATE),
    cachedreport: vi.fn(async () => null),
    // Each read answers the next report in the list, then the last one again.
    report: vi.fn(async () => {
      const projects = reports[Math.min(read++, reports.length - 1)];
      const r: MachineReport = { version: 1, ueMcp: "1.4.13", daemonDir: "D", projects, daemons: [] };
      return { ok: true, report: JSON.stringify(r) };
    }),
    live: vi.fn(async () => o.live ?? {}),
    newest: vi.fn(async () => o.newest ?? { channel: "beta", ueMcp: "1.4.14", studio: "0.1.35", plugin: "0.1.8", errors: {} }),
    daemon: vi.fn(async ({ path }: { path: string }) => (path === "/v1/health" && o.health ? { status: 200, body: o.health } : { error: "not running" })),
    readlog: vi.fn(async () => "listening on 127.0.0.1:41001"),
    updatebridge: vi.fn(async () => ({ ok: true, job: 7 })),
    openstudio: vi.fn(async () => ({ ok: true })),
    startdaemon: vi.fn(async () => ({ ok: true, job: 8 })),
    stopdaemon: vi.fn(async () => ({ ok: true, job: 9 })),
    job: vi.fn(async () => ({ running: false, ok: true, lines: ["done"] })),
    getchannel: vi.fn(async () => ({ channel: "beta" })),
    appupdate: vi.fn(async () => ({ ok: true, channel: "beta", version: "0.1.35", newer: false })),
  };
  appSlot().ue = { app: app as unknown as Record<string, (arg?: unknown) => Promise<unknown>> };
  return app;
}

/** The project rows, once the report is drawn. */
async function projectRows(): Promise<HTMLElement[]> {
  await screen.findByRole("heading", { name: "Projects" });
  await waitFor(() => expect(document.querySelectorAll(".app-list > li.app-project").length).toBeGreaterThan(0));
  return [...document.querySelectorAll<HTMLElement>(".app-list > li.app-project")];
}

afterEach(() => {
  cleanup();
  resetWork();
  delete appSlot().ue;
});

describe("the UE-MCP app's Projects", () => {
  it("lists each project once with its folder, versions, daemon and an update badge from the channel's newest, without a daemon", async () => {
    const h = fakeHost();
    render(<App />);
    const rows = await projectRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("ue-mcp\\tests")).toBeTruthy();
    expect(within(rows[1]).getByText("ue-mcp-release\\tests")).toBeTruthy();
    await waitFor(() => expect(within(rows[0]).getByText("Update available")).toBeTruthy());
    expect(within(rows[0]).getByText("Daemon stopped")).toBeTruthy();
    expect(rows[0].textContent).toContain("Studio 0.1.34");
    expect(rows[0].textContent).toContain("Editor plugin 0.1.8");
    expect(h.daemon).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Updates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Daemons" })).toBeNull();
  });

  it("opens a project's detail with what Update installs, and runs ue-mcp update for a project without Studio", async () => {
    const h = fakeHost();
    render(<App />);
    const rows = await projectRows();
    fireEvent.click(within(rows[1]).getByTitle("Details for ue_mcp"));
    await screen.findByText("What Update installs");
    expect(screen.getByText(/The bridge plugin from ue-mcp 1\.4\.14/)).toBeTruthy();
    expect(screen.getByText("Runs ue-mcp update --apply-only for ue_mcp.")).toBeTruthy();
    await screen.findByText(/listening on 127\.0\.0\.1/);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(h.updatebridge).toHaveBeenCalledWith({ uproject: bare.uproject, version: "1.4.14" }));
    await screen.findByText("The bridge plugin is updated");
  });

  it("hands a Studio project's update to its Studio", async () => {
    const h = fakeHost();
    render(<App />);
    const rows = await projectRows();
    await waitFor(() => expect(within(rows[0]).getByRole("button", { name: "Update" })).toBeTruthy());
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(h.openstudio).toHaveBeenCalledWith({ key: withStudio.key, uproject: withStudio.uproject, location: "#/settings/general" }));
  });

  it("starts a stopped daemon, and asks again before stopping one in use", async () => {
    const h = fakeHost({ live: { [withStudio.key]: { pid: 11, port: 41001, version: "1.4.13" } }, health: JSON.stringify({ editors: [{ name: "x", connected: true }], clients: 2 }) });
    render(<App />);
    const rows = await projectRows();
    await waitFor(() => expect(within(rows[0]).getByText("Daemon running")).toBeTruthy());
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(h.startdaemon).toHaveBeenCalledWith({ uproject: bare.uproject }));
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Stop" }));
    await within(rows[0]).findByText(/disconnects 1 editor connected, 2 clients/);
    expect(h.stopdaemon).not.toHaveBeenCalled();
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Stop anyway" }));
    await waitFor(() => expect(h.stopdaemon).toHaveBeenCalledWith({ uproject: withStudio.uproject }));
  });

  it("reads the list again when the host says a watched file changed, and says when it was read", async () => {
    const updated = { ...withStudio, extensions: { studio: "0.1.35" } };
    const h = fakeHost({ reports: [[withStudio, bare], [updated, bare]] });
    render(<App />);
    const rows = await projectRows();
    await waitFor(() => expect(rows[0].textContent).toContain("Studio 0.1.34"));
    expect(await screen.findByText(/^Read at /)).toBeTruthy();
    window.dispatchEvent(new CustomEvent("ue-app", { detail: "changed" }));
    await waitFor(() => expect(document.querySelector(".app-list > li.app-project")!.textContent).toContain("Studio 0.1.35"));
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it("reads the list again every time the window is activated", async () => {
    const h = fakeHost();
    render(<App />);
    await projectRows();
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new CustomEvent("ue-app", { detail: "focus" }));
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(2));
  });

  it("reads once more when a change lands while a read runs", async () => {
    const h = fakeHost();
    render(<App />);
    await projectRows();
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1));
    let finish: (v: unknown) => void = () => {};
    h.report.mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new CustomEvent("ue-app", { detail: "changed" }));
    finish({ ok: true, report: JSON.stringify({ version: 1, ueMcp: "1.4.13", daemonDir: "D", projects: [withStudio, bare], daemons: [] }) });
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(3));
  });

  it("after handing an update to Studio, reads the list again until the project's versions change", async () => {
    const every = WATCH_UPDATE.everyMs;
    WATCH_UPDATE.everyMs = 20;
    try {
      const updated = { ...withStudio, extensions: { studio: "0.1.35" } };
      fakeHost({ reports: [[withStudio, bare], [withStudio, bare], [withStudio, bare], [updated, bare]] });
      render(<App />);
      const rows = await projectRows();
      await waitFor(() => expect(within(rows[0]).getByRole("button", { name: "Update" })).toBeTruthy());
      fireEvent.click(within(rows[0]).getByRole("button", { name: "Update" }));
      await screen.findByText(/Studio is running the update/);
      await waitFor(() => expect(document.querySelector(".app-list > li.app-project")!.textContent).toContain("Studio 0.1.35"));
      await waitFor(() => expect(screen.queryByText(/Studio is running the update/)).toBeNull());
    } finally {
      WATCH_UPDATE.everyMs = every;
    }
  });

  it("keeps the channel and UE-MCP's own update in Settings", async () => {
    fakeHost();
    render(<App initial="settings" />);
    await screen.findByRole("radiogroup", { name: "Release channel" });
    expect(screen.getByText(/Node\.js v22\.11\.0 is installed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add project" })).toBeTruthy();
  });
});
