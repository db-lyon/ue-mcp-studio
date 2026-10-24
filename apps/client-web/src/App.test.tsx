// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const sessions = [
  { id: "s1", title: "First", status: "idle", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 },
  { id: "s2", title: "Second", status: "idle", createdAt: 2, updatedAt: 2, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 },
];
const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), saveDraft: vi.fn(), events: [] as unknown[] }));
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "events" ? undefined : t[k]) ?? pending });
  return { api, ApiError: class extends Error {} };
});
vi.mock("./state", () => ({ useDaemon: () => ({ events: m.events, health: null, streaming: true, error: null, refresh: () => {} }) }));
vi.mock("./views/SettingsHub", () => ({ SettingsHub: () => <div>Settings view</div> }));
vi.mock("./views/Flows", () => ({ FlowsView: () => <div>Flows view</div> }));
vi.mock("./views/EditorBanner", () => ({ EditorBanner: () => null }));
vi.mock("./views/DialogBanner", () => ({ DialogBanner: () => null }));
vi.mock("./views/UpdateOverlay", () => ({ UpdateRunner: () => null }));
import { App } from "./App";

const COMPOSER = "Ask for something in the editor, or drop files here";

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
  window.location.hash = "#/chat/s1";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
