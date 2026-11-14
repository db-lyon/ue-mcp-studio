// @vitest-environment jsdom
// The bar's Subagents badge counts what the Subagents list shows: once the finished
// subagents are cleared, the badge drops to the running ones, the same number the list has.
// Wide, the list is inline under the composer and the button shows and hides it, never
// opening a second copy; narrow, there is no inline list and the button opens it in a sheet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SUBAGENTS_SHOWN_KEY } from "@ue-mcp-studio/client-core";

const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), dismissAgents: vi.fn(), saveDraft: vi.fn() }));
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "sessionSync" ? (id: string) => m.session(id) : t[k] ?? pending) });
  return { api, ApiError: class extends Error {} };
});
import { ChatView } from "./views/Chat";

const daemon = { events: [], health: null, streaming: true, error: null, refresh: () => {} } as never;
const started = new Date(Date.now() - 60_000).toISOString();
const agent = (id: string, done: boolean) => ({
  kind: "tool",
  call: { id, name: "agent", input: { description: `Task ${id}`, prompt: "x" }, outcome: done ? "done" : "pending", startedAt: started, ...(done ? { endedAt: new Date().toISOString(), result: "ok" } : {}) },
});
const finished = Array.from({ length: 12 }, (_, i) => `f${i}`);
const session = (dismissed: string[]) => ({
  id: "s1", title: "Cave", status: "running", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 14, running: 2 }, awaiting: 0,
  mainFree: true, draft: "", seen: [], dismissed,
  transcript: [{ kind: "user", text: "dress the cave", at: new Date().toISOString() }, agent("r1", false), agent("r2", false), ...finished.map((id) => agent(id, true))],
});

/** This device's storage, as a page has it: Node's own global has none without a file. */
let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, String(v)), removeItem: (k: string) => void stored.delete(k), clear: () => stored.clear() },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

/** A narrow window: the media query the chat lays out by matches. */
function narrowWindow() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

async function open(dismissed: string[] = []) {
  window.location.hash = "#/chat/s1";
  const s = session(dismissed);
  m.sessions.mockResolvedValue({ sessions: [s] });
  m.session.mockResolvedValue(s);
  m.dismissAgents.mockResolvedValue({ dismissed: finished });
  m.saveDraft.mockResolvedValue(undefined);
  render(<ChatView daemon={daemon} />);
  return screen.findByRole("button", { name: /^Subagents \(\d+\)$/ });
}

const inlineList = () => screen.queryByRole("tablist", { name: "Subagents" });

describe("the bar's Subagents badge", () => {
  it("counts every subagent while none is dismissed", async () => {
    expect((await open()).getAttribute("aria-label")).toBe("Subagents (14)");
  });

  it("drops to the running ones after Clear finished, matching the list", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Subagents \(\d+\)$/ }).getAttribute("aria-label")).toBe("Subagents (2)"));
    expect(m.dismissAgents).toHaveBeenCalledWith("s1", finished);
    expect(screen.getAllByText(/^Subagents: /).map((e) => e.textContent)).toEqual(["Subagents: 2 working"]);
    expect(screen.queryByRole("button", { name: /Finished \(/ })).toBeNull();
  });

  it("reads the daemon's dismissals: a session reopened after clearing says 2", async () => {
    expect((await open(finished)).getAttribute("aria-label")).toBe("Subagents (2)");
  });
});

describe("the Subagents button where the list is inline (wide)", () => {
  it("shows the list by default and is pressed", async () => {
    const button = await open();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(inlineList()).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides the list, leaving nothing of it, and shows it again; never opens a sheet; the badge stays", async () => {
    const button = await open();
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(inlineList()).toBeNull();
    expect(document.querySelector(".agents-bar")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Subagents (14)");
    expect(stored.get(SUBAGENTS_SHOWN_KEY)).toBe("hidden");
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(inlineList()).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored.get(SUBAGENTS_SHOWN_KEY)).toBe("shown");
  });

  it("remembers this viewer's choice to hide it", async () => {
    stored.set(SUBAGENTS_SHOWN_KEY, "hidden");
    const button = await open();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(inlineList()).toBeNull();
  });

  it("shows the list when storage throws", async () => {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    const button = await open();
    expect(inlineList()).toBeTruthy();
    fireEvent.click(button);
    expect(inlineList()).toBeNull();
  });

  it("brings a shown list scrolled out of view back into view instead of hiding it", async () => {
    const button = await open();
    const list = inlineList()!;
    const scroll = vi.fn();
    list.scrollIntoView = scroll;
    list.getBoundingClientRect = () => ({ top: window.innerHeight + 200, bottom: window.innerHeight + 400, height: 200, left: 0, right: 100, width: 100, x: 0, y: window.innerHeight + 200, toJSON: () => ({}) });
    fireEvent.click(button);
    expect(scroll).toHaveBeenCalled();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(inlineList()).toBeTruthy();
  });
});

describe("the Subagents button where there is no inline list (narrow)", () => {
  it("opens the list in a sheet, the only list on screen, with one header line", async () => {
    narrowWindow();
    const button = await open();
    expect(button.getAttribute("aria-pressed")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => fireEvent.click(button));
    const sheet = screen.getByRole("dialog");
    expect(sheet.getAttribute("aria-label")).toBe("Subagents: 2 working, 12 done");
    expect(within(sheet).getAllByText(/^Subagents: /).map((e) => e.textContent)).toEqual(["Subagents: 2 working, 12 done"]);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });
});
