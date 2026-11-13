// @vitest-environment jsdom
/** The four chat and header mount points: nothing in the DOM with no contributions, and each contribution in its place. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SlotContribution, SlotName } from "@ue-mcp-studio/extension-api";

const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), saveDraft: vi.fn() }));
vi.mock("../api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "sessionSync" ? (id: string) => m.session(id) : t[k] ?? pending) });
  return { api, ApiError: class extends Error {} };
});
vi.mock("../state", () => ({ useDaemon: () => ({ events: [], health: null, streaming: true, error: null, refresh: () => {} }) }));
vi.mock("../views/EditorBanner", () => ({ EditorBanner: () => null }));
vi.mock("../views/DialogBanner", () => ({ DialogBanner: () => null }));
vi.mock("../views/UpdateOverlay", () => ({ UpdateRunner: () => null }));
import { App } from "../App";
import { clearSlots, register } from "./registry";

const COMPOSER = "Ask for something in the editor, or drop files here";
const s1 = { id: "s1", title: "First", status: "idle", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 1, running: 0 }, awaiting: 0 };
const agentCall = { kind: "tool", call: { id: "a1", name: "agent", input: { description: "look" }, outcome: "done", startedAt: "2026-11-02T10:00:01Z", endedAt: "2026-11-02T10:00:02Z" } };
const reply = (text: string, s: number) => ({ kind: "assistant", text, at: `2026-11-02T10:00:0${s}Z` });
const card = { kind: "card", ext: "pro", type: "plan", data: { left: 3 }, at: "2026-11-02T10:00:04Z" };
// A turn that ran a subagent: its earlier replies fold behind the last one, and a card sits between them.
const withCard = [{ kind: "user", text: "Plan it", at: "2026-11-02T10:00:00Z" }, agentCall, reply("first", 3), card, reply("second", 5), reply("final", 6)];
const withoutCard = withCard.filter((e) => e !== card);

function layout(narrow: boolean) {
  window.matchMedia = ((query: string) => ({ matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
}

async function openChat(transcript: unknown[] = withCard) {
  m.session.mockImplementation(() => Promise.resolve({ ...s1, transcript, draft: "", queue: [], approvals: [], touched: [], seen: [], dismissed: [] }));
  const view = render(<App />);
  await screen.findByPlaceholderText(COMPOSER);
  await screen.findByText("final");
  return view;
}

/** The markup at each mount point. */
const regions = () => ({
  toolbar: document.querySelector(".bar-tools")!.innerHTML,
  composer: document.querySelector(".composer-bar")!.innerHTML,
  conversation: document.querySelector(".card.conversation")!.innerHTML,
  transcript: document.querySelector(".transcript")!.innerHTML,
});

/** Registers inside act; the function returned removes it. */
function reg<S extends SlotName>(slot: S, c: SlotContribution<S>, ext: string): () => void {
  let remove = () => {};
  act(() => void (remove = register(slot, c, ext)));
  return remove;
}

function contribution<S extends SlotName>(id: string, seen: Array<Record<string, unknown>>, title?: string): SlotContribution<S> {
  return {
    id,
    title,
    mount(el, ctx) {
      seen.push(ctx as never);
      const b = document.createElement("button");
      b.textContent = id;
      el.appendChild(b);
      return { update: (next) => void seen.push(next as never), unmount: () => void seen.push({ unmounted: id }) };
    },
  };
}

beforeEach(() => {
  layout(false);
  m.sessions.mockResolvedValue({ sessions: [s1] });
  m.saveDraft.mockResolvedValue(undefined);
  window.location.hash = "#/chat/s1";
});

afterEach(() => {
  cleanup();
  clearSlots();
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("mount points with nothing registered", () => {
  it("add no element anywhere", async () => {
    await openChat();
    expect(document.querySelector(".ext-slot, .ext-panel")).toBeNull();
  });

  it("toolbar.action: the bar's tools are as they were, and a contribution comes first among them", async () => {
    await openChat();
    const before = regions().toolbar;
    const remove = reg("toolbar.action", contribution("usage", []), "pro");
    const tools = document.querySelector(".bar-tools")!;
    expect(tools.firstElementChild?.matches('.ext-slot[data-slot="toolbar.action"]')).toBe(true);
    expect(tools.textContent).toContain("usage");
    act(() => remove());
    expect(regions().toolbar).toBe(before);
  });

  it("composer.action: the composer bar is as it was, and a contribution sits right after the utilities (Attach last) with the composer's context", async () => {
    await openChat();
    const before = regions().composer;
    const seen: Array<Record<string, unknown>> = [];
    const remove = reg("composer.action", contribution("enhance", seen), "pro");
    const slot = document.querySelector('.composer-bar .ext-slot[data-slot="composer.action"]')!;
    expect(slot.previousElementSibling?.classList.contains("composer-utilities")).toBe(true);
    expect(slot.previousElementSibling?.lastElementChild?.classList.contains("attach-button")).toBe(true);
    expect(seen[0]).toMatchObject({ sessionId: "s1", draft: "", busy: false });
    act(() => (seen[0].setDraft as (t: string) => void)("from the extension"));
    expect((screen.getByPlaceholderText(COMPOSER) as HTMLTextAreaElement).value).toBe("from the extension");
    expect(seen.at(-1)).toMatchObject({ draft: "from the extension" });
    expect(typeof seen[0].addFiles).toBe("function");
    act(() => (seen[0].setDraft as (t: string) => void)(""));
    act(() => remove());
    expect(seen.at(-1)).toEqual({ unmounted: "enhance" });
    expect(regions().composer).toBe(before);
  });

  it("session.panel: nothing between the thread and the queue, and a contribution gets a collapsible region there", async () => {
    await openChat();
    const before = regions().conversation;
    expect(document.querySelector(".session-stage")!.nextElementSibling?.matches("details")).toBe(false);
    const seen: Array<Record<string, unknown>> = [];
    const remove = reg("session.panel", contribution("budget", seen, "Budget"), "pro");
    const panel = document.querySelector(".session-stage")!.nextElementSibling!;
    expect(panel.matches("details.ext-panel[open]")).toBe(true);
    expect(panel.querySelector("summary")!.textContent).toBe("Budget");
    expect(panel.querySelector('.ext-slot[data-slot="session.panel"]')!.textContent).toBe("budget");
    expect(seen[0]).toMatchObject({ sessionId: "s1", status: "idle" });
    act(() => remove());
    expect(regions().conversation).toBe(before);
  });

  it("chat.card: a card nothing draws leaves the transcript exactly as if it were not there", async () => {
    const without = await openChat(withoutCard);
    const expected = regions().transcript;
    without.unmount();
    await openChat(withCard);
    expect(regions().transcript).toBe(expected);
  });

  it("chat.card: the contribution registered for ext:type draws the card with its data", async () => {
    await openChat();
    const seen: Array<Record<string, unknown>> = [];
    reg("chat.card", contribution("plan", seen), "other");
    expect(document.querySelector('.transcript .ext-slot[data-slot="chat.card"]')).toBeNull();
    const remove = reg("chat.card", contribution("plan", seen), "pro");
    const el = document.querySelector('.transcript .ext-slot[data-slot="chat.card"][data-ext="pro"]')!;
    expect(el.textContent).toBe("plan");
    expect(seen.at(-1)).toMatchObject({ sessionId: "s1", data: { left: 3 } });
    act(() => remove());
    expect(document.querySelector('.transcript .ext-slot[data-ext="pro"]')).toBeNull();
  });

  it("narrow: the drawer's tools take a toolbar contribution too, and nothing without one", async () => {
    layout(true);
    await openChat();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(document.querySelector(".ext-slot")).toBeNull();
    reg("toolbar.action", contribution("usage", []), "pro");
    expect(document.querySelector('.bar-tools > .ext-slot[data-slot="toolbar.action"]')).toBeTruthy();
  });
});
