// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { DEFAULT_DEVICE_NOTIFY, applyProjectNotify, DEFAULT_PROJECT_NOTIFY, type NotifyTarget, type ProjectNotifyPrefs } from "@ue-mcp-studio/shared";
import { focusRun } from "./attention";
import { PRESENCE_EVERY_MS } from "@ue-mcp-studio/client-core";
import { DEVICE_PREFS_KEY, NOTIFICATION_CLICK, PRESENCE_CHECK_MS, loadDesktopPrefs, loadProjectNotify, pageInUse, resetNotifyState, useNotifications, usePresence } from "./notify";

let prefs: ProjectNotifyPrefs = DEFAULT_PROJECT_NOTIFY;
/** The computer's device settings the agent keeps (GET /notifications/desktop), and what the page sent. */
let kept: unknown = null;
const sent: Array<{ method: string; path: string; body: unknown }> = [];
beforeEach(() => {
  prefs = DEFAULT_PROJECT_NOTIFY;
  kept = null;
  sent.length = 0;
  resetNotifyState();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url), "http://x").pathname;
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith("/notifications/desktop")) return method === "GET" ? new Response(JSON.stringify({ prefs: kept }), { status: 200 }) : new Response(null, { status: 204 });
      if (method !== "GET") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ project: "Vale", prefs, recent: [] }), { status: 200 });
    }),
  );
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  delete window.ue;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const notice = (over: Record<string, unknown> = {}) => ({ id: "n1", kind: "turn.finished", project: "Vale", at: "x", sessionId: "s1", title: "Fix the door", text: "Ready for your review", target: { sessionId: "s1" }, active: [], ...over });
const ev = (id: number, data: Record<string, unknown>, type = "studio.notify"): DaemonEvent => ({ id, type, at: "x", data });

function Probe({ events, onOpen }: { events: DaemonEvent[]; onOpen: (t: NotifyTarget) => void }) {
  useNotifications(events, onOpen);
  return null;
}

async function arrive(events: DaemonEvent[], onOpen: (t: NotifyTarget) => void = () => {}) {
  const r = render(<Probe events={[]} onOpen={onOpen} />);
  await act(async () => void (await loadProjectNotify(true)));
  await act(async () => void r.rerender(<Probe events={events} onOpen={onOpen} />));
  await act(async () => void (await Promise.resolve()));
  return r;
}

describe("a notice on this device", () => {
  it("shows a Windows notification from Studio's window, with the project, and the session to open", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    await arrive([ev(1, notice())]);
    expect(notify).toHaveBeenCalledWith(JSON.stringify({ id: "n1", title: "Vale: Fix the door", text: "Ready for your review", target: { sessionId: "s1" }, group: "Vale" }));
  });

  it("shows only the event and the project when details are hidden", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify({ ...DEFAULT_DEVICE_NOTIFY, privacy: "minimal" }));
    await arrive([ev(1, notice())]);
    expect(notify).toHaveBeenCalledWith(JSON.stringify({ id: "n1", title: "Turn finished", text: "Vale", target: { sessionId: "s1" }, group: "Vale" }));
  });

  it("flashes the editor where there is no notify", async () => {
    const drawattention = vi.fn(async () => true);
    window.ue = { studio: { drawattention } as never };
    await arrive([ev(1, notice({ kind: "playtest.needs-you", title: "Fix the door", text: "A playtest loop needs you", target: { sessionId: "s1", runId: "r1" } }))]);
    expect(drawattention).toHaveBeenCalledWith("Vale: Fix the door - A playtest loop needs you");
  });

  it("uses the browser's notification on a plain page, and its click opens the session", async () => {
    const shown: Array<{ title: string; options: NotificationOptions; onclick?: () => void; close: () => void }> = [];
    class FakeNotification {
      static permission = "granted";
      onclick?: () => void;
      close = vi.fn();
      constructor(public title: string, public options: NotificationOptions) {
        shown.push(this as never);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(window, "focus").mockImplementation(() => {});
    const onOpen = vi.fn();
    await arrive([ev(1, notice())], onOpen);
    expect(shown[0]).toMatchObject({ title: "Vale: Fix the door", options: { body: "Ready for your review", tag: "uemcp:turn.finished:Vale" } });
    shown[0].onclick!();
    expect(onOpen).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("stays quiet for a muted session and an event turned off", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    prefs = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["s1"], events: { "approval.waiting": false } });
    await arrive([ev(1, notice()), ev(2, notice({ id: "n2", kind: "approval.waiting", sessionId: "s2", target: { sessionId: "s2" } }))]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("never stays quiet for its own window being open and in use, away mode on or off", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify, lastinput: vi.fn(async () => 1_000) } as never, studioWindow: true };
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await arrive([ev(1, notice({ active: ["desktop"] }))]);
    expect(notify).toHaveBeenCalledTimes(1);
    cleanup();
    resetNotifyState();
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify({ ...DEFAULT_DEVICE_NOTIFY, onlyWhenAway: false }));
    await arrive([ev(2, notice({ id: "n2", active: ["desktop", "browser", "phone"] }))]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("only when away: stays quiet while the owner uses another device, and logs the input age", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify, lastinput: vi.fn(async () => 3_900_000) } as never, studioWindow: true };
    await arrive([ev(1, notice({ active: ["phone"] }))]);
    expect(notify).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ path: "/v1/ext/studio/notifications/delivery", body: expect.objectContaining({ noticeId: "n1", device: "desktop", shown: false, why: "active", inputAgeMs: 3_900_000 }) }));
  });

  it("does not repeat a notice from before the page loaded", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    const r = render(<Probe events={[ev(5, notice())]} onOpen={() => {}} />);
    await act(async () => void r.rerender(<Probe events={[ev(5, notice()), ev(6, { sessionId: "s1" }, "studio.session.changed")]} onOpen={() => {}} />));
    expect(notify).not.toHaveBeenCalled();
  });

  it("decides a notice once when the stream brings it twice, out of id order, or to a remounted view", async () => {
    const notify = vi.fn(async () => JSON.stringify({ ok: true, via: "toast" }));
    window.ue = { studio: { notify, lastinput: vi.fn(async () => 1_000) } as never, studioWindow: true };
    const fresh = notice({ at: new Date().toISOString() });
    const r = await arrive([ev(10, fresh), ev(9, { stage: "agent" }, "studio.notify.trace"), ev(10, fresh)]);
    await act(async () => void r.rerender(<Probe events={[ev(10, fresh), ev(9, { stage: "agent" }, "studio.notify.trace"), ev(10, fresh), ev(11, { stage: "device" }, "studio.notify.trace")]} onOpen={() => {}} />));
    cleanup();
    await arrive([ev(10, fresh)]);
    await act(async () => void (await new Promise((done) => setTimeout(done, 0))));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sent.filter((x) => x.path.endsWith("/notifications/delivery"))).toHaveLength(1);
  });

  it("skips a notice from before the page loaded that the stream's backlog replays", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    await arrive([ev(3, notice({ id: "old", at: new Date(Date.now() - 60 * 60_000).toISOString() }))]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("says when Studio's window had already shown the notice", async () => {
    const notify = vi.fn(async () => JSON.stringify({ ok: true, via: "toast", duplicate: true }));
    window.ue = { studio: { notify } as never, studioWindow: true };
    await arrive([ev(1, notice())]);
    await act(async () => void (await new Promise((done) => setTimeout(done, 0))));
    expect(sent).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ shown: true, via: "window", ok: true, detail: "toast, already shown" }) }));
  });

  it("opens the session when the window's notification is clicked", () => {
    const onOpen = vi.fn();
    render(<Probe events={[]} onOpen={onOpen} />);
    window.dispatchEvent(new CustomEvent(NOTIFICATION_CLICK, { detail: { sessionId: "s1", runId: "r1" } }));
    expect(onOpen).toHaveBeenCalledWith({ sessionId: "s1", runId: "r1" });
  });

  it("scrolls to a playtest's card once it is drawn", async () => {
    vi.useFakeTimers();
    focusRun("r1");
    const el = document.createElement("div");
    el.setAttribute("data-run-id", "r1");
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    vi.advanceTimersByTime(150);
    expect(el.scrollIntoView).toHaveBeenCalled();
    expect(el.classList.contains("attention")).toBe(true);
    vi.useRealTimers();
    el.remove();
  });
});

describe("in use", () => {
  it("Studio's window: input anywhere on the computer within two minutes, and the window focused", async () => {
    const lastinput = vi.fn(async () => 30_000);
    window.ue = { studio: { lastinput } as never, studioWindow: true };
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await pageInUse()).toEqual({ active: true, inputAgeMs: 30_000 });
    lastinput.mockResolvedValue(3_600_000);
    expect(await pageInUse()).toEqual({ active: false, inputAgeMs: 3_600_000 });
    lastinput.mockResolvedValue(10_000);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(await pageInUse()).toEqual({ active: false, inputAgeMs: 10_000 });
  });

  it("a browser: only input on its own page counts, none yet is not in use", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await pageInUse()).toEqual({ active: false });
    window.dispatchEvent(new KeyboardEvent("keydown"));
    const use = await pageInUse();
    expect(use.active).toBe(true);
    expect(use.inputAgeMs).toBeLessThan(1_000);
  });

  it("presence reports idle with the input age, and in use once the owner comes back", async () => {
    const lastinput = vi.fn(async () => 3_600_000);
    window.ue = { studio: { lastinput } as never, studioWindow: true };
    vi.mocked(document.hasFocus).mockReturnValue(true);
    function P() {
      usePresence();
      return null;
    }
    render(<P />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(sent.at(-1)).toMatchObject({ path: "/v1/ext/studio/notifications/presence", body: { device: "desktop", active: false, inputAgeMs: 3_600_000 } });
    lastinput.mockResolvedValue(2_000);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(sent.at(-1)).toMatchObject({ body: { active: true, inputAgeMs: 2_000 } });
  });

  it("presence keeps reporting while idle, so the agent keeps listing the page", async () => {
    vi.useFakeTimers();
    window.ue = { studio: { lastinput: vi.fn(async () => 3_600_000) } as never, studioWindow: true };
    function P() {
      usePresence();
      return null;
    }
    render(<P />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const reports = () => sent.filter((x) => x.path.endsWith("/notifications/presence"));
    expect(reports()).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(PRESENCE_EVERY_MS + PRESENCE_CHECK_MS)));
    expect(reports().length).toBeGreaterThanOrEqual(2);
    expect(reports().at(-1)).toMatchObject({ body: { active: false } });
    vi.useRealTimers();
  });
});

describe("the computer's own settings", () => {
  it("the copy the agent keeps wins over the page's storage, which starts empty on a new port", async () => {
    kept = { ...DEFAULT_DEVICE_NOTIFY, onlyWhenAway: false };
    await loadDesktopPrefs();
    expect(JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY)!)).toMatchObject({ onlyWhenAway: false });
  });

  it("a page with settings and no kept copy hands its own over", async () => {
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify({ ...DEFAULT_DEVICE_NOTIFY, privacy: "minimal" }));
    await loadDesktopPrefs();
    expect(sent).toContainEqual(expect.objectContaining({ method: "PUT", path: "/v1/ext/studio/notifications/desktop", body: expect.objectContaining({ privacy: "minimal" }) }));
  });
});

describe("opened from a push", () => {
  it("goes to the session of the newest notice, and drops the marker from the address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ project: "Vale", prefs: DEFAULT_PROJECT_NOTIFY, recent: [notice({ id: "a", target: { sessionId: "old" } }), notice({ id: "b", target: { sessionId: "new", runId: "r2" } })] }), { status: 200 })));
    window.history.replaceState(null, "", "/ui/?from=push#/chat");
    const onOpen = vi.fn();
    render(<Probe events={[]} onOpen={onOpen} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(onOpen).toHaveBeenCalledWith({ sessionId: "new", runId: "r2" });
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/chat");
  });
});
