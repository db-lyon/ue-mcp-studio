// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { appSlot, type HostState, type IdeInfo, type Newest, type OpenIde } from "./native";
import type { MachineProject, MachineReport } from "./model";
import { resetIdes, resetWork, WATCH_UPDATE } from "./actions";

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

const IDES: IdeInfo = {
  ok: true,
  ides: [{ id: "vs:afb8a0c3", kind: "vs", name: "Visual Studio Community 2022" }, { id: "vscode", kind: "vscode", name: "Visual Studio Code" }],
  chosen: "vs:afb8a0c3", remembered: "", preferred: "", solution: "C:\\work\\ue-mcp\\tests\\ue_mcp\\ue_mcp.sln", workspace: null, source: true, generate: true,
};

function fakeHost(o: { newest?: Newest; live?: Record<string, { pid: number; port: number; version: string }>; health?: string; reports?: MachineProject[][]; ides?: IdeInfo; openide?: OpenIde; hidden?: Array<{ name: string; uproject: string; dir: string }> } = {}) {
  const reports = o.reports ?? [[withStudio, bare]];
  let read = 0;
  const app = {
    getstate: vi.fn(async () => STATE),
    cachedreport: vi.fn(async () => null),
    // Each read answers the next report in the list, then the last one again.
    report: vi.fn(async () => {
      const projects = reports[Math.min(read++, reports.length - 1)];
      const r: MachineReport = { version: 1, ueMcp: "1.4.13", daemonDir: "D", projects, ...(o.hidden ? { hidden: o.hidden } : {}), daemons: [] };
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
    ides: vi.fn(async () => o.ides ?? IDES),
    openide: vi.fn(async (_: { ide?: string }) => o.openide ?? { ok: true }),
    projectfiles: vi.fn(async () => ({ ok: true, job: 10 })),
    reveal: vi.fn(async () => true),
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
  resetIdes();
  delete appSlot().ue;
});

describe("a report this app cannot read", () => {
  it("offers Update UE-MCP, which opens Settings where the update is, beside Check again", async () => {
    const h = fakeHost();
    h.report.mockResolvedValue({ ok: false, reason: "version", ueMcp: "ue-mcp@2.0.0" } as never);
    render(<App />);
    await screen.findByRole("heading", { name: "Update UE-MCP to see your projects" });
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update UE-MCP" }));
    await waitFor(() => expect(document.querySelector(".app-nav-item.active")?.textContent).toContain("Settings"));
  });
});

describe("a ue-mcp without the projects command", () => {
  it("names the installed and needed versions, and Update ue-mcp fetches the newest and reads the list with it", async () => {
    const h = fakeHost();
    const ok = h.report.getMockImplementation()!;
    h.report.mockResolvedValueOnce({ ok: false, reason: "unsupported", ueMcp: "ue-mcp@1.4.13", need: "1.4.14-beta.1" } as never);
    const updateuemcp = vi.fn(ok);
    (h as Record<string, unknown>).updateuemcp = updateuemcp;
    render(<App />);
    await screen.findByRole("heading", { name: "Update ue-mcp to see your projects" });
    expect(screen.getByText("ue-mcp 1.4.13 is installed. Listing your projects needs ue-mcp 1.4.14-beta.1 or newer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update ue-mcp" }));
    await waitFor(() => expect(updateuemcp).toHaveBeenCalled());
    expect(await projectRows()).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Update ue-mcp to see your projects" })).toBeNull();
  });
});

describe("unverified state", () => {
  it("draws the last run's editor state and updates as checking until this session's read answers, then as fact", async () => {
    const open = { ...withStudio, editor: { running: true, pids: [42] } };
    const h = fakeHost({ reports: [[{ ...withStudio, editor: { running: false, pids: [] } }]] });
    h.cachedreport.mockResolvedValue(JSON.stringify({ version: 1, ueMcp: "1.4.13", daemonDir: "D", projects: [open], daemons: [] }) as never);
    let answer!: () => void;
    const first = h.report.getMockImplementation()!;
    h.report.mockImplementationOnce(() => new Promise((r) => (answer = () => r(first() as never))));
    render(<App />);
    const rows = await projectRows();
    expect(within(rows[0]).queryByText("Editor open")).toBeNull();
    expect(within(rows[0]).getByText("Checking editor")).toBeTruthy();
    expect(within(rows[0]).getByText("Checking updates")).toBeTruthy();
    expect((within(rows[0]).getByRole("button", { name: "Launch editor" }) as HTMLButtonElement).disabled).toBe(true);
    answer();
    await waitFor(() => expect(within(rows[0]).queryByText("Checking editor")).toBeNull());
    expect(within(rows[0]).queryByText("Editor open")).toBeNull();
  });

  it("says a read is waiting on the one-time ue-mcp install, not just Reading, while the host installs it", async () => {
    const h = fakeHost();
    h.cachedreport.mockResolvedValue(JSON.stringify({ version: 1, ueMcp: "1.4.13", daemonDir: "D", projects: [withStudio], daemons: [] }) as never);
    let answer!: () => void;
    const first = h.report.getMockImplementation()!;
    h.report.mockImplementationOnce(() => new Promise((r) => (answer = () => r(first() as never))));
    render(<App />);
    await projectRows();
    act(() => void window.dispatchEvent(new CustomEvent("ue-app", { detail: "installing" })));
    expect(await screen.findByRole("button", { name: "Installing ue-mcp (one time)" })).toBeTruthy();
    act(() => void window.dispatchEvent(new CustomEvent("ue-app", { detail: "installed" })));
    expect(await screen.findByRole("button", { name: "Reading" })).toBeTruthy();
    answer();
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("says unknown, not the last value, when this session's read failed", async () => {
    const open = { ...withStudio, editor: { running: true, pids: [42] } };
    const h = fakeHost();
    h.report.mockResolvedValue({ ok: false, reason: "failed", error: "offline", cached: JSON.stringify({ version: 1, ueMcp: "1.4.13", daemonDir: "D", projects: [open], daemons: [] }), cachedAt: "2026-11-11T23:37:00Z" } as never);
    render(<App />);
    const rows = await projectRows();
    await waitFor(() => expect(within(rows[0]).getByText("Editor unknown")).toBeTruthy());
    expect(within(rows[0]).queryByText("Editor open")).toBeNull();
  });
});

describe("Hide this project", () => {
  it("keeps a removed project off an earlier list shown while the read fails", async () => {
    const h = fakeHost();
    const removeproject = vi.fn(async () => ({ ok: true }));
    (h as Record<string, unknown>).removeproject = removeproject;
    render(<App />);
    const rows = await projectRows();
    const first = await h.report.mock.results[0].value;
    h.report.mockResolvedValue({ ok: false, reason: "failed", error: "offline", cached: first.report, cachedAt: "2026-11-11T23:37:00Z" } as never);
    fireEvent.click(within(rows[0]).getByRole("button", { name: /more/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide this project" }));
    await waitFor(() => expect(removeproject).toHaveBeenCalledWith({ uproject: withStudio.uproject }));
    await waitFor(() => expect(document.querySelectorAll(".app-list > li.app-project")).toHaveLength(1));
  });

  it("shows Hiding on the row until the removal resolves, and ignores a second press", async () => {
    const h = fakeHost();
    let finish!: (v: { ok: boolean }) => void;
    const removeproject = vi.fn(() => new Promise<{ ok: boolean }>((r) => { finish = r; }));
    (h as Record<string, unknown>).removeproject = removeproject;
    render(<App />);
    const rows = await projectRows();
    fireEvent.click(within(rows[0]).getByRole("button", { name: /more/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide this project" }));
    expect(await within(rows[0]).findByText("Hiding")).toBeTruthy();
    expect(rows[0].getAttribute("aria-busy")).toBe("true");
    fireEvent.click(within(rows[0]).getByRole("button", { name: /more/i }));
    const again = screen.getByRole("menuitem", { name: "Hide this project" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(removeproject).toHaveBeenCalledTimes(1);
    finish({ ok: false });
    await waitFor(() => expect(within(rows[0]).queryByText("Hiding")).toBeNull());
  });

  it("says why a removal failed instead of dropping it", async () => {
    const h = fakeHost();
    (h as Record<string, unknown>).removeproject = vi.fn(async () => ({ ok: false, error: "npm error code ETARGET" }));
    render(<App />);
    const rows = await projectRows();
    fireEvent.click(within(rows[0]).getByRole("button", { name: /more/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide this project" }));
    expect(await screen.findByText(/could not be hidden: npm error code ETARGET/)).toBeTruthy();
  });
});

describe("Hidden projects", () => {
  const gone = { name: "Gone", uproject: "C:/p/Gone/Gone.uproject", dir: "C:/p/Gone" };

  it("is absent with none hidden, and with a report that has no hidden list", async () => {
    fakeHost();
    render(<App />);
    await projectRows();
    expect(screen.queryByText(/Hidden projects/)).toBeNull();
    cleanup();
    fakeHost({ hidden: [] });
    render(<App />);
    await projectRows();
    expect(screen.queryByText(/Hidden projects/)).toBeNull();
  });

  it("is a collapsed fold with a count, and Show restores through the host then reads again", async () => {
    const h = fakeHost({ hidden: [gone] });
    let finish!: (v: { ok: boolean }) => void;
    const addproject = vi.fn(() => new Promise<{ ok: boolean }>((r) => { finish = r; }));
    (h as Record<string, unknown>).addproject = addproject;
    render(<App />);
    await projectRows();
    const fold = screen.getByText("Hidden projects (1)").closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(screen.getByText("Gone")).toBeTruthy();
    const reads = h.report.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Show", hidden: true }));
    expect(await screen.findByRole("button", { name: "Showing", hidden: true })).toBeTruthy();
    expect(addproject).toHaveBeenCalledWith({ uproject: gone.uproject });
    finish({ ok: true });
    await waitFor(() => expect(h.report.mock.calls.length).toBeGreaterThan(reads));
  });
});

describe("Add project", () => {
  it("is disabled and reads Adding until the picker resolves", async () => {
    const h = fakeHost();
    let finish!: (v: { ok: boolean; cancelled: boolean }) => void;
    const addproject = vi.fn(() => new Promise<{ ok: boolean; cancelled: boolean }>((r) => { finish = r; }));
    (h as Record<string, unknown>).addproject = addproject;
    render(<App />);
    await projectRows();
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    const busy = (await screen.findByRole("button", { name: "Adding" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(addproject).toHaveBeenCalledTimes(1);
    finish({ ok: false, cancelled: true });
    await screen.findByRole("button", { name: "Add project" });
  });
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
    // The versions are folded away under one Versions toggle, closed by default.
    const fold = rows[0].querySelector("details.app-versions-fold") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")?.textContent).toBe("Versions");
    expect(fold.textContent).toContain("Studio 0.1.34");
    expect(fold.textContent).toContain("Editor plugin 0.1.8");
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

  it("View Updates on a project without Studio opens its detail, where Update is", async () => {
    fakeHost();
    render(<App />);
    const rows = await projectRows();
    await waitFor(() => expect(within(rows[1]).getByRole("button", { name: "View Updates" })).toBeTruthy());
    fireEvent.click(within(rows[1]).getByRole("button", { name: "View Updates" }));
    await screen.findByText("What Update installs");
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("hands a Studio project's update to its Studio", async () => {
    const h = fakeHost();
    render(<App />);
    const rows = await projectRows();
    await waitFor(() => expect(within(rows[0]).getByRole("button", { name: "View Updates" })).toBeTruthy());
    fireEvent.click(within(rows[0]).getByRole("button", { name: "View Updates" }));
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
      await waitFor(() => expect(within(rows[0]).getByRole("button", { name: "View Updates" })).toBeTruthy());
      fireEvent.click(within(rows[0]).getByRole("button", { name: "View Updates" }));
      await screen.findByText(/Studio is running the update/);
      await waitFor(() => expect(document.querySelector(".app-list > li.app-project")!.textContent).toContain("Studio 0.1.35"));
      await waitFor(() => expect(screen.queryByText(/Studio is running the update/)).toBeNull());
    } finally {
      WATCH_UPDATE.everyMs = every;
    }
  });

  it("opens a project in its IDE, or with another from Open with..., and shows it in Explorer", async () => {
    const h = fakeHost();
    render(<App />);
    const rows = await projectRows();
    fireEvent.click(within(rows[0]).getByTitle("Details for ue_mcp"));
    const open = await screen.findByRole("button", { name: "Open in Visual Studio" });
    expect(open.getAttribute("title")).toBe("Visual Studio Community 2022. Opens ue_mcp.sln.");
    fireEvent.click(open);
    await waitFor(() => expect(h.openide).toHaveBeenCalledWith({ key: withStudio.key, uproject: withStudio.uproject }));
    fireEvent.click(screen.getByRole("button", { name: "Open ue_mcp with" }));
    const code = screen.getByRole("menuitemradio", { name: /Visual Studio Code/ });
    expect(screen.getByRole("menuitemradio", { name: /Community 2022/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(code);
    await waitFor(() => expect(h.openide).toHaveBeenLastCalledWith({ key: withStudio.key, uproject: withStudio.uproject, ide: "vscode", remember: "yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Show in Explorer" }));
    expect(h.reveal).toHaveBeenCalledWith({ uproject: withStudio.uproject });
  });

  it("offers to generate the project files when Visual Studio has no solution, then opens it", async () => {
    const h = fakeHost({ ides: { ...IDES, solution: null }, openide: { ok: false, needsProjectFiles: true, ide: "vs:afb8a0c3", name: "Visual Studio Community 2022" } });
    render(<App />);
    const rows = await projectRows();
    fireEvent.click(within(rows[0]).getByRole("button", { name: "More for ue_mcp" }));
    const open = await within(rows[0]).findByRole("menuitem", { name: "Open in Visual Studio" });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(open);
    await within(rows[0]).findByText(/has no Visual Studio solution yet/);
    expect(within(rows[0]).getByRole("button", { name: "Open folder in VS Code" })).toBeTruthy();
    h.openide.mockResolvedValue({ ok: true });
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Generate project files" }));
    await waitFor(() => expect(h.projectfiles).toHaveBeenCalledWith({ uproject: withStudio.uproject }));
    await within(rows[0]).findByText("The project files are generated");
    await waitFor(() => expect(h.openide).toHaveBeenLastCalledWith({ key: withStudio.key, uproject: withStudio.uproject, ide: "vs:afb8a0c3" }));
  });

  it("keeps the channel and UE-MCP's own update in Settings", async () => {
    fakeHost();
    render(<App initial="settings" />);
    await screen.findByRole("radiogroup", { name: "Release channel" });
    expect(screen.getByText(/Node\.js v22\.11\.0 is installed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add project" })).toBeTruthy();
  });
});
