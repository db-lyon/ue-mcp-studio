/**
 * The shell around an open project, as the web client draws it on a phone:
 * the lock screen and PIN sheet, the connection line and panel, the refusal
 * screen, the banners, the drawer, the update overlay and the error boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createLock, REMOTE_RECONNECT_MS, type Transport } from "@ue-mcp-studio/client-core";
import type { SessionSummary } from "@ue-mcp-studio/shared";
import { RemoteLock } from "../src/views/remote/RemoteLock";
import { ConnectionOverlay, useConnection } from "../src/views/ConnectionOverlay";
import { RefusedScreen } from "../src/views/Refused";
import { VersionNotice } from "../src/views/VersionNotice";
import { DrawerTool, NavDrawer, useDrawerClose } from "../src/views/NavDrawer";
import { EditorBanner } from "../src/views/EditorBanner";
import { DialogBanner } from "../src/views/DialogBanner";
import { resetRunForTests, UpdateRunner } from "../src/views/UpdateOverlay";
import { ErrorBoundary } from "../src/views/ErrorBoundary";
import type { DaemonState } from "../src/state";
import { ProjectContext } from "../src/nav";
import { PageGlow, stopOf, ThemeProvider } from "../src/ui";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});

function lockAnswering(state: Record<string, unknown>, answer: (pin: string) => { status: number; body: unknown }) {
  const t: Transport = async (_m, path, o) => {
    if (!path.endsWith("/unlock")) return json(200, state);
    const r = answer((o?.json as { pin: string }).pin);
    return json(r.status, r.body);
  };
  return createLock(t);
}

const LOCKED = { whole: true, sensitive: false, locked: true, sensitiveOpen: true, idleMinutes: 15, pinLength: 4 };

const daemon = (over: Partial<DaemonState> = {}): DaemonState => ({ health: null, error: null, streaming: true, events: [], refresh: () => undefined, ...over });

afterEach(() => {
  vi.useRealTimers();
  resetRunForTests();
});

describe("the lock screen", () => {
  it("covers the app while locked and submits on the last digit", async () => {
    const pins: string[] = [];
    const lock = lockAnswering(LOCKED, (pin) => (pins.push(pin), { status: 200, body: { ...LOCKED, locked: false } }));
    await lock.refresh();
    render(<RemoteLock lock={lock} computerKey="k" />);
    expect(screen.getByText("Studio is locked")).toBeTruthy();
    expect(screen.getByText("Enter the PIN set in Studio on your computer.")).toBeTruthy();
    expect(screen.getByLabelText("0 of 4 digits entered")).toBeTruthy();
    for (const d of ["1", "2", "3"]) fireEvent.click(screen.getByLabelText(d));
    expect(screen.getByLabelText("3 of 4 digits entered")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("4"));
    await settle();
    expect(pins).toEqual(["1234"]);
    expect(screen.queryByText("Studio is locked")).toBeNull();
  });

  it("deletes a digit, and shows an enter key only while the PIN's length is unknown", async () => {
    const pins: string[] = [];
    const lock = lockAnswering({ ...LOCKED, pinLength: undefined }, (pin) => (pins.push(pin), { status: 200, body: { ...LOCKED, locked: false } }));
    await lock.refresh();
    render(<RemoteLock lock={lock} computerKey="k" />);
    expect(screen.getByLabelText("0 of up to 8 digits entered")).toBeTruthy();
    for (const d of ["9", "9"]) fireEvent.click(screen.getByLabelText(d));
    fireEvent.click(screen.getByLabelText("Delete"));
    for (const d of ["1", "2", "3"]) fireEvent.click(screen.getByLabelText(d));
    fireEvent.click(screen.getByLabelText("Unlock"));
    await settle();
    expect(pins).toEqual(["9123"]);
  });

  it("says a wrong PIN, the wait before the next try, and the tries left", async () => {
    const lock = lockAnswering(LOCKED, () => ({ status: 403, body: { error: "Wrong PIN.", remaining: 3, retryAfterMs: 32_000 } }));
    await lock.refresh();
    render(<RemoteLock lock={lock} computerKey="k" />);
    for (const d of ["1", "1", "1", "1"]) fireEvent.click(screen.getByLabelText(d));
    await settle();
    expect(screen.getByText("Wrong PIN.")).toBeTruthy();
    expect(screen.getByText("Try again in 32 s.")).toBeTruthy();
    expect(screen.getByText("3 tries left before this browser is removed.")).toBeTruthy();
    expect(screen.getByLabelText("0 of 4 digits entered")).toBeTruthy();
    // Blocked while the wait runs: a key does nothing.
    fireEvent.click(screen.getByLabelText("5"));
    expect(screen.getByLabelText("0 of 4 digits entered")).toBeTruthy();
  });

  it("opens with the computer's own wait and tries left", async () => {
    const lock = lockAnswering({ ...LOCKED, pinLength: undefined, remaining: 1, retryAfterMs: 5000 }, () => ({ status: 200, body: {} }));
    await lock.refresh();
    render(<RemoteLock lock={lock} computerKey="k" />);
    expect(screen.getByText("Try again in 5 s.")).toBeTruthy();
    expect(screen.getByText("1 try left before this browser is removed.")).toBeTruthy();
  });

  it("tells a removed phone to pair again", async () => {
    const lock = lockAnswering(LOCKED, () => ({ status: 403, body: { error: "Removed.", unpaired: true } }));
    await lock.refresh();
    const removed = vi.fn();
    render(<RemoteLock lock={lock} computerKey="k" onRemoved={removed} />);
    for (const d of ["1", "1", "1", "1"]) fireEvent.click(screen.getByLabelText(d));
    await settle();
    expect(screen.getByText("This browser was removed")).toBeTruthy();
    fireEvent.click(screen.getByText("Pair again"));
    expect(removed).toHaveBeenCalled();
  });
});

describe("the PIN sheet", () => {
  it("asks for the PIN for one action, and Cancel gives up on it", async () => {
    let n = 0;
    const t: Transport = async (_m, path) => {
      if (path === "/v1/ext/studio/lock") return json(200, { ...LOCKED, whole: false, locked: false, sensitive: true });
      return json(423, { error: "Enter your PIN to do this.", code: "pin-required", n: ++n });
    };
    const lock = createLock(t);
    await lock.refresh();
    const guarded = lock.guard(t);
    render(<RemoteLock lock={lock} computerKey="k" />);
    let answered: number | null = null;
    await act(async () => {
      void guarded("POST", "/v1/ext/studio/sessions/s/approvals/a").then((r) => (answered = r.status));
    });
    expect(screen.getByText("Enter your PIN")).toBeTruthy();
    expect(screen.getByText("This action needs the PIN set in Studio on your computer.")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    await settle();
    expect(screen.queryByText("Enter your PIN")).toBeNull();
    expect(answered).toBe(423);
  });
});

function Conn() {
  return <ConnectionOverlay c={useConnection(false, [], false)} />;
}

describe("the connection to ue-mcp", () => {
  it("shows the quiet Reconnecting line when ue-mcp answers while the stream is down", async () => {
    vi.useFakeTimers();
    const alive = new Set<(at: number) => void>();
    const { project } = fakeProject();
    project.onAlive = (l) => (alive.add(l), () => void alive.delete(l));
    renderInProject(<Conn />, fakeApi(), project);
    expect(screen.queryByText("Reconnecting to ue-mcp")).toBeNull();
    act(() => alive.forEach((l) => l(Date.now())));
    expect(screen.getByText("Reconnecting to ue-mcp")).toBeTruthy();
  });

  it("says ue-mcp on the computer is offline after the wait, with Retry and nothing to run", async () => {
    vi.useFakeTimers();
    const { project } = fakeProject();
    project.reconnect = vi.fn();
    renderInProject(<Conn />, fakeApi(), project);
    for (let t = 0; t <= REMOTE_RECONNECT_MS + 1000; t += 1000) await act(async () => void vi.advanceTimersByTime(1000));
    expect(screen.getByText("ue-mcp on your computer is offline")).toBeTruthy();
    expect(screen.getByText(/there is nothing to run here/)).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(project.reconnect).toHaveBeenCalled();
  });
});

describe("refused", () => {
  it("names the ue-mcp Studio needs and says updates run on the computer", () => {
    render(<RefusedScreen refusal={{ needs: "1.4.11-beta.6", have: "1.4.11-beta.4" }} />);
    expect(screen.getByText("Studio needs ue-mcp 1.4.11-beta.6. You have 1.4.11-beta.4.")).toBeTruthy();
    expect(screen.getByText("Updates run from Studio on the computer.")).toBeTruthy();
    expect(screen.queryByText("Update ue-mcp")).toBeNull();
  });
});

describe("banners", () => {
  it("says another project installed a newer Studio, with no buttons on a phone", async () => {
    const api = fakeApi();
    api.versionNotice.mockResolvedValue({ notice: { installed: "0.1.25", current: "0.1.23" } });
    renderInProject(<VersionNotice daemon={daemon()} />, api);
    await settle();
    expect(screen.getByText(/Studio 0.1.25 was installed by another project. This project uses 0.1.23./)).toBeTruthy();
    expect(screen.getByText(/Updates run from Studio on the computer./)).toBeTruthy();
    expect(screen.queryByText("Update this project")).toBeNull();
  });

  it("shows the editor off as a chip that opens the banner with Start", async () => {
    const api = fakeApi();
    api.busy.mockResolvedValue({ now: Date.now(), calls: [] });
    api.editor.mockResolvedValue({ steps: [{ ok: true }] });
    renderInProject(<EditorBanner daemon={daemon({ health: { version: "1", editors: [{ name: "E", connected: false }] } })} compact />, api);
    await settle();
    fireEvent.click(screen.getByText("Editor off"));
    expect(screen.getByText("Editor not running")).toBeTruthy();
    fireEvent.click(screen.getByText("Start"));
    expect(api.editor).toHaveBeenCalledWith("start");
  });

  it("shows a busy editor with the call and its timer", async () => {
    const api = fakeApi();
    api.busy.mockResolvedValue({ now: Date.now(), calls: [{ id: "c", category: "level", action: "build_lighting", startedAt: Date.now() - 65_000, source: "studio" }] });
    api.stopBusy.mockResolvedValue({ stopped: ["c"] });
    renderInProject(<EditorBanner daemon={daemon()} compact />, api);
    await settle();
    fireEvent.click(screen.getByText(/Editor busy 1:0\d/));
    expect(screen.getByText(/level\(build_lighting\)/)).toBeTruthy();
    fireEvent.click(screen.getByText("Stop"));
    expect(api.stopBusy).toHaveBeenCalled();
  });

  it("names a dialog holding the editor", async () => {
    const api = fakeApi();
    api.dialogs.mockResolvedValue({ now: Date.now(), dialogs: [{ id: "d", title: "Save changes?", message: "", buttons: [], openedAt: new Date().toISOString(), held: false, policy: { kind: "wait" } }] });
    renderInProject(<DialogBanner daemon={daemon()} />, api);
    await settle();
    expect(screen.getByText("Editor waiting on a dialog:")).toBeTruthy();
    expect(screen.getByText(/Save changes\?/)).toBeTruthy();
  });
});

describe("the navigation drawer", () => {
  const summary = (id: string, title: string, over: Partial<SessionSummary> = {}): SessionSummary =>
    ({ id, title, status: "idle", createdAt: "", updatedAt: "", waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0, ...over }) as SessionSummary;

  it("holds New session, the tabs, the recent sessions and the tools, and closes on a pick", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [summary("a", "Dress the cave", { status: "running" }), summary("b", "Old", { archived: true })] });
    const picked: string[] = [];
    const onClose = vi.fn();
    renderInProject(
      <NavDrawer open onClose={onClose} tab="Chat" session="a" updates={2} onTab={(t) => picked.push(t)} onSession={(id) => picked.push(id)} onNewSession={() => picked.push("new")}>
        <></>
      </NavDrawer>,
      api,
    );
    expect(screen.getByText("Loading")).toBeTruthy();
    await settle();
    expect(screen.getByText("Dress the cave")).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
    expect(screen.queryByText("Playtests")).toBeNull();
    expect(screen.getByLabelText("2 updates available")).toBeTruthy();
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByText("Dress the cave"));
    fireEvent.click(screen.getByText("New session"));
    expect(picked).toEqual(["Settings", "a", "new"]);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("draws the tabs, New session and the recents at the editor themes' 12px button size, and the foot tools at 14px", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [summary("a", "Dress the cave")] });
    // react-native-web draws a style as an atomic class; jsdom does not order those rules, so read the class's own rule.
    const size = (text: string) => {
      const cls = Array.from(screen.getByText(text).classList).find((c) => c.startsWith("r-fontSize-"));
      for (const sheet of Array.from(document.styleSheets))
        for (const rule of Array.from(sheet.cssRules)) if (rule.cssText.includes(`.${cls}`)) return /font-size:\s*([^;}]+)/.exec(rule.cssText)?.[1].trim();
      return null;
    };
    for (const [theme, item, foot] of [["editor", "12px", "14px"], ["ue-mcp", "14.5px", "14px"]] as const) {
      const view = renderInProject(
        <ThemeProvider name={theme}>
          <NavDrawer open onClose={() => undefined} tab="Chat" session="a" updates={0} onTab={() => undefined} onSession={() => undefined} onNewSession={() => undefined}>
            <DrawerTool title="Feedback" onPress={() => undefined} />
          </NavDrawer>
        </ThemeProvider>,
        api,
      );
      await settle();
      expect([size("Chat"), size("New session"), size("Feedback")]).toEqual([item, item, foot]);
      expect(size("Dress the cave")).toBe(theme === "editor" ? "12px" : "14px");
      view.unmount();
    }
  });

  it("closes when a tool at its foot opens its sheet, and keeps the tool mounted while closed", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [] });
    const onClose = vi.fn();
    const opened: string[] = [];
    function SheetTool() {
      const close = useDrawerClose();
      return (
        <>
          <DrawerTool title="Feedback" onPress={() => opened.push("feedback")} />
          <button onClick={() => (opened.push("vcs"), close())}>Git</button>
        </>
      );
    }
    const view = renderInProject(
      <NavDrawer open onClose={onClose} tab="Chat" session={null} updates={0} onTab={() => undefined} onSession={() => undefined} onNewSession={() => undefined}>
        <SheetTool />
      </NavDrawer>,
      api,
    );
    await settle();
    fireEvent.click(screen.getByText("Feedback"));
    fireEvent.click(screen.getByText("Git"));
    expect(opened).toEqual(["feedback", "vcs"]);
    expect(onClose).toHaveBeenCalledTimes(2);
    // Closed, the foot stays mounted (a sheet it opened lives there) but is hidden, as the web's drawer-root goes visibility: hidden.
    view.rerender(
      <ProjectContext.Provider value={view.nav}>
        <NavDrawer open={false} onClose={onClose} tab="Chat" session={null} updates={0} onTab={() => undefined} onSession={() => undefined} onNewSession={() => undefined}>
          <SheetTool />
        </NavDrawer>
      </ProjectContext.Provider>,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
    const up: HTMLElement[] = [];
    for (let el: HTMLElement | null = screen.getByText("Git"); el; el = el.parentElement) up.push(el);
    expect(up.some((el) => el.style.opacity === "0" && el.style.visibility === "hidden")).toBe(true);
  });

  it("says so when there are no sessions", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [] });
    renderInProject(<NavDrawer open onClose={() => undefined} tab="Plugins" session={null} updates={0} onTab={() => undefined} onSession={() => undefined} onNewSession={() => undefined} />, api);
    await settle();
    expect(screen.getByText("No sessions yet.")).toBeTruthy();
  });
});

describe("an update run on the computer", () => {
  it("follows the run's steps from its events, and a kept update offers Restart now", async () => {
    const run = { steps: [{ key: "plugin", state: "done" }, { key: "studio", state: "active" }], target: null, at: Date.now() };
    const ev = (id: number, data: Record<string, unknown>, type = "studio.update.run") => ({ id, type, at: "", data });
    const view = renderInProject(<UpdateRunner streaming events={[ev(1, { run })]} />);
    const rerender = (ui: React.ReactNode) => view.rerender(<ProjectContext.Provider value={view.nav}>{ui}</ProjectContext.Provider>);
    expect(screen.getByText("Updating")).toBeTruthy();
    expect(screen.getByText("Editor plugin")).toBeTruthy();
    expect(screen.getByText("ue-mcp restarts. This panel reloads when it is back.")).toBeTruthy();
    const kept = { ...run, steps: [{ key: "studio", state: "deferred" }] };
    rerender(<UpdateRunner streaming events={[ev(1, { run }), ev(2, { run: kept })]} />);
    expect(screen.getByText(/when the current turn finishes/)).toBeTruthy();
    fireEvent.click(screen.getByText("Restart now"));
    expect(screen.getByText("Restart and stop the turn")).toBeTruthy();
    expect(screen.getByText(/Restarting now stops the turn in progress/)).toBeTruthy();
  });

  it("keeps the banner's 10px under a stopped update's reason, above Close, as the web's .banner does", () => {
    const run = { steps: [{ key: "plugin", state: "failed" }], target: null, at: Date.now(), error: "The editor plugin did not install." };
    renderInProject(<UpdateRunner streaming events={[{ id: 1, type: "studio.update.run", at: "", data: { run } }]} />);
    const box = screen.getByText("The editor plugin did not install.").parentElement!;
    expect(getComputedStyle(box).marginBottom).toBe("10px");
    expect(screen.getByText("Close")).toBeTruthy();
  });
});

describe("the error boundary", () => {
  it("shows what broke with Reload in place of the part", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let boom = true;
    function Part() {
      if (boom) throw new Error("bad data");
      return <>fine</>;
    }
    render(
      <ThemeProvider name="ue-mcp">
        <ErrorBoundary what="Chat">
          <Part />
        </ErrorBoundary>
      </ThemeProvider>,
    );
    expect(screen.getByText("Chat could not be shown.")).toBeTruthy();
    expect(screen.getByText("bad data")).toBeTruthy();
    boom = false;
    fireEvent.click(screen.getByText("Reload"));
    expect(screen.getByText("fine")).toBeTruthy();
    err.mockRestore();
  });
});

describe("the app shell", () => {
  it("takes the project's Studio theme, and draws the bar with the tab's name", async () => {
    const { AppShell } = await import("../src/AppShell");
    const t: Transport = async (method, path) => {
      if (path === "/v1/ext/studio/settings") return json(200, { theme: "editor" });
      if (path === "/v1/ext/studio/lock") return json(200, { ...LOCKED, whole: false, locked: false });
      if (path === "/v1/health") return json(200, { version: "1", editors: [{ name: "E", connected: true }] });
      if (path === "/v1/events") return { status: 200, headers: {}, body: (async function* () { await new Promise(() => undefined); })() };
      return json(method === "GET" ? 404 : 409, { error: "no" });
    };
    const themes: string[] = [];
    render(
      <ThemeProvider name="ue-mcp" onChange={(n) => themes.push(n)}>
        <AppShell device={{ id: "d", name: "Lyra", online: true, computerKey: "k", lastSeen: "" }} transport={t} initial={{ tab: "Plugins", session: null, section: null }} onBack={() => undefined} onUnpaired={() => undefined} />
      </ThemeProvider>,
    );
    await settle();
    await settle();
    expect(themes).toEqual(["editor"]);
    // The bar names the tab; the page under it says Plugins too, as an older ue-mcp has no plugins route.
    // The closed drawer stays mounted, hidden, as the web's does: its Plugins item is the third.
    expect(screen.getAllByText("Plugins").length).toBe(3);
    expect(screen.getByLabelText("Open navigation")).toBeTruthy();
  });
});

describe("the page glow", () => {
  it("draws the ue-mcp theme's radial glow over the top of the page, below the safe area, and nothing in the editor themes", () => {
    expect(stopOf("rgba(232, 114, 12, 0.07)")).toEqual({ color: "rgb(232, 114, 12)", opacity: 0.07 });
    expect(stopOf("#123456")).toEqual({ color: "#123456", opacity: 1 });
    const view = render(
      <ThemeProvider name="ue-mcp">
        <PageGlow top={24} />
      </ThemeProvider>,
    );
    // 900px 420px at 50% -120px, faded out at 70%: 24 - 120 + 0.7 * 420 px of the page.
    expect(screen.getByTestId("page-glow").style.height).toBe(`${24 - 120 + 0.7 * 420}px`);
    const stops = Array.from(view.container.querySelectorAll("stop"));
    expect(stops.map((s) => [s.getAttribute("offset"), s.getAttribute("stop-opacity")])).toEqual([["0", "0.07"], ["0.7", "0"]]);
    view.unmount();
    for (const name of ["editor", "editor-orange"] as const) {
      const v = render(
        <ThemeProvider name={name}>
          <PageGlow />
        </ThemeProvider>,
      );
      expect(screen.queryByTestId("page-glow")).toBeNull();
      v.unmount();
    }
  });
});
