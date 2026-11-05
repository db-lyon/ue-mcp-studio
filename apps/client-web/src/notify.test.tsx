// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { DEFAULT_DEVICE_NOTIFY, applyProjectNotify, DEFAULT_PROJECT_NOTIFY, type NotifyTarget, type ProjectNotifyPrefs } from "@ue-mcp-studio/shared";
import { focusRun } from "./attention";
import { DEVICE_PREFS_KEY, NOTIFICATION_CLICK, loadProjectNotify, resetNotifyState, useNotifications } from "./notify";

let prefs: ProjectNotifyPrefs = DEFAULT_PROJECT_NOTIFY;
beforeEach(() => {
  prefs = DEFAULT_PROJECT_NOTIFY;
  resetNotifyState();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ project: "Vale", prefs, recent: [] }), { status: 200 })));
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  delete window.ue;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const notice = (over: Record<string, unknown> = {}) => ({ id: "n1", kind: "turn.finished", project: "Vale", at: "x", sessionId: "s1", title: "Done: Fix the door", text: "The door opens now.", target: { sessionId: "s1" }, active: [], ...over });
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
    expect(notify).toHaveBeenCalledWith(JSON.stringify({ title: "Done: Fix the door", text: "Vale: The door opens now.", target: { sessionId: "s1" } }));
  });

  it("shows only the event and the project when details are hidden", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify({ ...DEFAULT_DEVICE_NOTIFY, privacy: "minimal" }));
    await arrive([ev(1, notice())]);
    expect(notify).toHaveBeenCalledWith(JSON.stringify({ title: "Turn finished", text: "Vale", target: { sessionId: "s1" } }));
  });

  it("flashes the editor where there is no notify", async () => {
    const drawattention = vi.fn(async () => true);
    window.ue = { studio: { drawattention } as never };
    await arrive([ev(1, notice({ kind: "playtest.needs-you", title: "Playtest needs you", text: "No progress.", target: { sessionId: "s1", runId: "r1" } }))]);
    expect(drawattention).toHaveBeenCalledWith("Vale: No progress.");
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
    expect(shown[0]).toMatchObject({ title: "Done: Fix the door", options: { body: "Vale: The door opens now.", tag: "uemcp:turn.finished:Vale" } });
    shown[0].onclick!();
    expect(onOpen).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("stays quiet for a muted session, an event turned off, and while the page is in use", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    prefs = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["s1"], events: { "approval.waiting": false } });
    await arrive([ev(1, notice()), ev(2, notice({ id: "n2", kind: "approval.waiting", sessionId: "s2", target: { sessionId: "s2" } }))]);
    expect(notify).not.toHaveBeenCalled();
    cleanup();
    prefs = DEFAULT_PROJECT_NOTIFY;
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await arrive([ev(3, notice({ id: "n3" }))]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not repeat a notice from before the page loaded", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    const r = render(<Probe events={[ev(5, notice())]} onOpen={() => {}} />);
    await act(async () => void r.rerender(<Probe events={[ev(5, notice()), ev(6, { sessionId: "s1" }, "studio.session.changed")]} onOpen={() => {}} />));
    expect(notify).not.toHaveBeenCalled();
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
