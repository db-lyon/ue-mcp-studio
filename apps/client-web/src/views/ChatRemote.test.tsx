// @vitest-environment jsdom
/**
 * /remote and /rc in the composer, and what a free account sees of remote
 * control outside Settings, for each state: STUDIO_PLAN_AVAILABLE off or on,
 * a free or a paid account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("@ue-mcp-studio/shared", async (original) => {
  const real = await original<typeof import("@ue-mcp-studio/shared")>();
  return {
    ...real,
    get STUDIO_PLAN_AVAILABLE() {
      return flag.on;
    },
  };
});
const sessions = [{ id: "s1", title: "First", status: "idle", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 }];
const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), saveDraft: vi.fn(), send: vi.fn(), remoteAvailable: vi.fn() }));
vi.mock("../api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => t[k] ?? pending });
  return { api, ApiError: class extends Error {} };
});
vi.mock("../state", () => ({ useDaemon: () => ({ events: [], health: null, streaming: true, error: null, refresh: () => {} }) }));
vi.mock("./SettingsHub", () => ({ SettingsHub: ({ section }: { section: string | null }) => <div>Settings view {section}</div> }));
vi.mock("./EditorBanner", () => ({ EditorBanner: () => null }));
vi.mock("./DialogBanner", () => ({ DialogBanner: () => null }));
vi.mock("./UpdateOverlay", () => ({ UpdateRunner: () => null }));
import { App } from "../App";
import { REMOTE_COMMAND_REPLY, STUDIO_PLAN_URL } from "@ue-mcp-studio/shared";

const COMPOSER = "Ask for something in the editor, or drop files here";

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
  m.sessions.mockResolvedValue({ sessions });
  m.session.mockImplementation((id: string) => Promise.resolve({ ...sessions.find((s) => s.id === id), transcript: [], draft: "" }));
  m.saveDraft.mockResolvedValue(undefined);
  m.send.mockResolvedValue(undefined);
  window.location.hash = "#/chat/s1";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  flag.on = false;
  window.location.hash = "";
});

async function open(o: { flag: boolean; paid: boolean }) {
  flag.on = o.flag;
  m.remoteAvailable.mockResolvedValue({ available: o.paid });
  render(<App />);
  const box = (await screen.findByPlaceholderText(COMPOSER)) as HTMLTextAreaElement;
  await act(async () => undefined);
  return box;
}

async function type(box: HTMLTextAreaElement, text: string) {
  await act(async () => void fireEvent.change(box, { target: { value: text } }));
}

async function enter(box: HTMLTextAreaElement) {
  await act(async () => void fireEvent.keyDown(box, { key: "Enter" }));
}

const menu = () => [...document.querySelectorAll(".slash-menu .slash-name")].map((e) => e.textContent);

describe("/remote and /rc", () => {
  it("flag off, free account: the command does not exist, and /rc goes out as an ordinary message", async () => {
    const box = await open({ flag: false, paid: false });
    expect(m.remoteAvailable).toHaveBeenCalledWith(false);
    await type(box, "/");
    expect(menu()).not.toContain("/remote");
    await type(box, "/r");
    expect(menu()).not.toContain("/remote");
    await type(box, "/rc ");
    await enter(box);
    expect(m.send).toHaveBeenCalledWith("s1", "/rc ", []);
    expect(screen.queryByText(REMOTE_COMMAND_REPLY)).toBeNull();
  });

  it.each([false, true])("paid account (flag %s): listed, also under /rc, and opens Settings > Remote control without a turn", async (on) => {
    const box = await open({ flag: on, paid: true });
    await type(box, "/");
    expect(menu()).toContain("/remote");
    await type(box, "/rc");
    expect(menu()).toEqual(["/remote"]);
    await type(box, "/rc ");
    await enter(box);
    expect(m.send).not.toHaveBeenCalled();
    expect(screen.getByText("Settings view remote")).toBeTruthy();
  });

  it("flag on, free account: listed, and answered in the chat with the plan link, no turn and no tokens", async () => {
    const box = await open({ flag: true, paid: false });
    await type(box, "/re");
    expect(menu()).toEqual(["/remote"]);
    await type(box, "/remote");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(m.send).not.toHaveBeenCalled();
    const reply = document.querySelector(".local-reply")!;
    expect(reply.textContent).toContain(REMOTE_COMMAND_REPLY);
    expect([...reply.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([STUDIO_PLAN_URL]);
    expect(box.value).toBe("");
    // /rc does the same.
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Dismiss" })));
    expect(screen.queryByText(REMOTE_COMMAND_REPLY, { exact: false })).toBeNull();
    await type(box, "/rc ");
    await enter(box);
    expect(screen.getByText(REMOTE_COMMAND_REPLY, { exact: false })).toBeTruthy();
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("a free account outside Settings", () => {
  it.each([false, true])("sees nothing of remote control anywhere but Settings (flag %s)", async (on) => {
    await open({ flag: on, paid: false });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/remote/i);
    expect(text).not.toMatch(/Pro or Studio/);
    expect(document.querySelector(`a[href="${STUDIO_PLAN_URL}"]`)).toBeNull();
    expect(document.querySelector(".remote-plan-note, .local-reply, [aria-label*='emote' i], [title*='emote' i]")).toBeNull();
  });
});
