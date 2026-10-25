// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { NOTIFICATION_CLICK, focusRun, useAttention, type AttentionTarget } from "./attention";

afterEach(() => {
  cleanup();
  delete window.ue;
});

const ev = (id: number, data: Record<string, unknown>, type = "studio.qa.attention"): DaemonEvent => ({ id, type, at: "x", data });
const NEEDS = { sessionId: "s1", runId: "r1", loopId: "l1", title: "Playtest needs you", text: "Playtest DoorOpens needs you: No progress." };

function Probe({ events, onOpen }: { events: DaemonEvent[]; onOpen: (t: AttentionTarget) => void }) {
  useAttention(events, onOpen);
  return null;
}

describe("a playtest that needs the user", () => {
  it("shows a Windows notification from Studio's window with the reason and the card to open", async () => {
    const notify = vi.fn(async () => true);
    const drawattention = vi.fn(async () => true);
    window.ue = { studio: { notify, drawattention } as never };
    const r = render(<Probe events={[]} onOpen={() => {}} />);
    await act(async () => void r.rerender(<Probe events={[ev(1, NEEDS)]} onOpen={() => {}} />));
    expect(notify).toHaveBeenCalledWith(JSON.stringify({ title: "Playtest needs you", text: NEEDS.text, target: { sessionId: "s1", runId: "r1" } }));
    expect(drawattention).not.toHaveBeenCalled();
  });

  it("flashes the window with the reason where there is no notify", async () => {
    const drawattention = vi.fn(async () => true);
    window.ue = { studio: { drawattention } as never };
    const r = render(<Probe events={[]} onOpen={() => {}} />);
    await act(async () => void r.rerender(<Probe events={[ev(1, NEEDS)]} onOpen={() => {}} />));
    expect(drawattention).toHaveBeenCalledWith(NEEDS.text);
  });

  it("does not notify again for an event from before the page loaded", async () => {
    const notify = vi.fn(async () => true);
    window.ue = { studio: { notify } as never };
    const r = render(<Probe events={[ev(5, NEEDS)]} onOpen={() => {}} />);
    await act(async () => void r.rerender(<Probe events={[ev(5, NEEDS), ev(6, { sessionId: "s1" }, "studio.session.changed")]} onOpen={() => {}} />));
    expect(notify).not.toHaveBeenCalled();
  });

  it("opens the card when the notification is clicked", () => {
    const onOpen = vi.fn();
    render(<Probe events={[]} onOpen={onOpen} />);
    window.dispatchEvent(new CustomEvent(NOTIFICATION_CLICK, { detail: { sessionId: "s1", runId: "r1" } }));
    expect(onOpen).toHaveBeenCalledWith({ sessionId: "s1", runId: "r1" });
  });

  it("scrolls to the card once it is drawn", async () => {
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
