// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const sessions = [
  { id: "s1", title: "First", status: "idle", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 },
  { id: "s2", title: "Second", status: "idle", createdAt: 2, updatedAt: 2, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 },
];
const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), saveDraft: vi.fn(), viewport: vi.fn(), events: [] as unknown[], settingsCrash: false }));
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "sessionSync" ? (id: string) => m.session(id) : (k === "events" ? undefined : t[k]) ?? pending) });
  return { api, ApiError: class extends Error {} };
});
vi.mock("./state", () => ({ useDaemon: () => ({ events: m.events, health: null, streaming: true, error: null, refresh: () => {} }) }));
vi.mock("./views/SettingsHub", () => ({
  SettingsHub: () => {
    if (m.settingsCrash) throw new TypeError("Cannot read properties of undefined (reading 'flatMap')");
    return <div>Settings view</div>;
  },
}));
vi.mock("./views/EditorBanner", () => ({ EditorBanner: () => null }));
vi.mock("./views/DialogBanner", () => ({ DialogBanner: () => null }));
vi.mock("./views/UpdateOverlay", () => ({ UpdateRunner: () => null }));
import { App } from "./App";

const COMPOSER = "Ask for something";

function layout(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as never;
}

beforeEach(() => {
  m.events = [];
  m.sessions.mockResolvedValue({ sessions });
  m.session.mockImplementation((id: string) => Promise.resolve({ ...sessions.find((s) => s.id === id), transcript: [], draft: "" }));
  m.saveDraft.mockResolvedValue(undefined);
  m.viewport.mockResolvedValue(null);
  window.location.hash = "#/chat/s1";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  m.settingsCrash = false;
  window.location.hash = "";
});

/** Open s1, write half a message and scroll the transcript, as the reader left it. */
async function leaveChatOpen() {
  const box = (await screen.findByPlaceholderText(COMPOSER)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "half written" } });
  const transcript = document.querySelector(".transcript") as HTMLElement;
  transcript.scrollTop = 120;
  return { box, transcript };
}

function expectSameChat(before: { box: HTMLTextAreaElement; transcript: HTMLElement }) {
  const box = screen.getByPlaceholderText(COMPOSER) as HTMLTextAreaElement;
  expect(box).toBe(before.box);
  expect(box.value).toBe("half written");
  expect(document.querySelector(".transcript")).toBe(before.transcript);
  expect(before.transcript.scrollTop).toBe(120);
  expect(window.location.hash).toBe("#/chat/s1");
  expect(document.querySelector("main.view-chat")?.classList.contains("parked")).toBe(false);
}

describe("returning to Chat from another tab", () => {
  it("wide: Chat, Settings, Chat shows the same session, scroll and draft", async () => {
    layout(false);
    render(<App />);
    const before = await leaveChatOpen();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Settings view")).toBeTruthy();
    // A wide panel opens Settings on General, the first section in the rail.
    expect(window.location.hash).toBe("#/settings/general");
    expect(document.querySelector("main.view-chat")?.classList.contains("parked")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expectSameChat(before);
    expect(screen.queryByText("Settings view")).toBeNull();
    expect(m.session).toHaveBeenCalledTimes(1);
  });

  it("narrow: the drawer's Chat entry goes back to the session, not the list", async () => {
    layout(true);
    render(<App />);
    const before = await leaveChatOpen();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Settings view")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expectSameChat(before);
    expect(document.querySelector(".chat")?.getAttribute("data-pane")).not.toBe("list");
  });

  it("narrow: a session picked in the drawer opens that session", async () => {
    layout(true);
    render(<App />);
    await leaveChatOpen();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Second" }));
    await waitFor(() => expect(m.session).toHaveBeenCalledWith("s2"));
    await waitFor(() => expect(window.location.hash).toBe("#/chat/s2"));
  });

  it("an editor quick ask from another tab switches to the session it started", async () => {
    layout(false);
    const view = render(<App />);
    await leaveChatOpen();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Settings view")).toBeTruthy();
    m.events = [{ id: 1, type: "studio.session.focus", data: { sessionId: "s2" }, at: 1 }];
    view.rerender(<App />);
    await waitFor(() => expect(m.session).toHaveBeenCalledWith("s2"));
    await waitFor(() => expect(window.location.hash).toBe("#/chat/s2"));
    expect(screen.queryByText("Settings view")).toBeNull();
  });

  it("an editor quick ask with no model connected opens the model picker's Settings section", async () => {
    layout(false);
    const view = render(<App />);
    await leaveChatOpen();
    m.events = [{ id: 1, type: "studio.session.focus", data: { section: "agents" }, at: 1 }];
    view.rerender(<App />);
    expect(await screen.findByText("Settings view")).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/settings/agents"));
  });

  it("a Chat never opened before mounts on first visit, from the location", async () => {
    layout(false);
    window.location.hash = "#/settings/general";
    render(<App />);
    expect(await screen.findByText("Settings view")).toBeTruthy();
    expect(document.querySelector("main.view-chat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(document.querySelector("main.view-chat:not(.parked) .chat")).not.toBeNull();
    await waitFor(() => expect(m.sessions).toHaveBeenCalled());
    expect(window.location.hash).toBe("#/chat");
  });
});

describe("the live viewport, on the computer and on a paired device", () => {
  const running = { access: "ok", editor: "connected", streamer: false, source: null, viewers: 0, pie: true };
  const setRemote = (on: boolean | undefined) => {
    (window as unknown as { __studioRemotePage?: boolean }).__studioRemotePage = on;
  };
  afterEach(() => setRemote(undefined));

  it("Studio on the computer lists no Viewport tab and no PIE indicator, even while PIE runs", async () => {
    layout(false);
    m.viewport.mockResolvedValue(running);
    render(<App />);
    await screen.findByPlaceholderText(COMPOSER);
    await waitFor(() => expect(m.sessions).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Viewport" })).toBeNull();
    expect(screen.getByRole("button", { name: "Plugins" })).toBeTruthy();
    expect(m.viewport).not.toHaveBeenCalled();
    expect(document.querySelector(".composer-pie")).toBeNull();
  });

  it("a paired browser lists no Viewport tab either, and shows the Live button while PIE runs", async () => {
    layout(false);
    setRemote(true);
    m.viewport.mockResolvedValue(running);
    render(<App />);
    await screen.findByPlaceholderText(COMPOSER);
    await waitFor(() => expect(document.querySelector(".live-button")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Viewport" })).toBeNull();
  });

  it("a link to the viewport opens the chat on the computer", async () => {
    layout(false);
    window.location.hash = "#/viewport";
    render(<App />);
    await waitFor(() => expect(document.querySelector("main.view-chat:not(.parked) .chat")).not.toBeNull());
    expect(document.querySelector("main.view-viewport")).toBeNull();
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
  });

  it("narrow: the drawer lists no Viewport tab, on the computer or on a paired device", async () => {
    layout(true);
    render(<App />);
    await screen.findByPlaceholderText(COMPOSER);
    expect(document.querySelectorAll(".drawer-item").length).toBeGreaterThan(0);
    expect([...document.querySelectorAll(".drawer-item")].some((b) => b.textContent === "Viewport")).toBe(false);
    cleanup();
    setRemote(true);
    render(<App />);
    await screen.findByPlaceholderText(COMPOSER);
    expect([...document.querySelectorAll(".drawer-item")].some((b) => b.textContent === "Viewport")).toBe(false);
  });
});

describe("a view that throws", () => {
  it("Settings shows why in its place, and the tabs and the chat keep working (#151)", async () => {
    layout(false);
    m.settingsCrash = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<App />);
      const before = await leaveChatOpen();
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Settings could not be shown.");
      expect(screen.getByText(/reading 'flatMap'/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Chat" }));
      await waitFor(() => expectSameChat(before));
    } finally {
      quiet.mockRestore();
    }
  });
});
