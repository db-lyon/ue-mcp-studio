// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useFollow, useSeen } from "./hooks";

afterEach(cleanup);

/** A list whose scroll metrics the test sets, since jsdom lays nothing out. */
function List({ n, sent }: { n: number; sent?: number }) {
  const f = useFollow<HTMLDivElement>(n, sent);
  return (
    <>
      <div data-testid="list" ref={f.ref} onScroll={f.onScroll}>{n}</div>
      {f.behind && <button onClick={f.jump}>New messages</button>}
    </>
  );
}

function metrics(el: HTMLElement, m: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: m.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: m.clientHeight });
}

describe("following the newest line", () => {
  it("stays at the bottom when the list gets shorter, and not once scrolled up", () => {
    let resized = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { resized = cb; }
      observe() {}
      disconnect() {}
    });
    try {
      render(<List n={1} />);
      const el = screen.getByTestId("list");
      metrics(el, { scrollHeight: 1000, clientHeight: 200 });
      resized();
      expect(el.scrollTop).toBe(1000);
      el.scrollTop = 100;
      fireEvent.scroll(el);
      resized();
      expect(el.scrollTop).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** A ResizeObserver that, like the browser's, reports only the elements it observes. */
  function observeSizes() {
    const observed = new Set<Element>();
    let report = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { report = cb; }
      observe(el: Element) { observed.add(el); }
      unobserve(el: Element) { observed.delete(el); }
      disconnect() { observed.clear(); }
    });
    return { resized: (el: Element) => { if (observed.has(el)) report(); } };
  }

  function Lines() {
    const f = useFollow<HTMLDivElement>(1);
    return (
      <div data-testid="list" ref={f.ref} onScroll={f.onScroll}>
        <p data-testid="line">A line set in a web font that loads later</p>
        <details data-testid="tool"><summary>tool</summary>output</details>
      </div>
    );
  }

  it("stays at the bottom when a line grows after layout, such as when web fonts load", () => {
    const sizes = observeSizes();
    try {
      render(<Lines />);
      const el = screen.getByTestId("list");
      metrics(el, { scrollHeight: 1000, clientHeight: 200 });
      sizes.resized(el);
      expect(el.scrollTop).toBe(1000);
      // The fonts load: the line wraps taller, the list itself keeps its size.
      metrics(el, { scrollHeight: 1038, clientHeight: 200 });
      sizes.resized(screen.getByTestId("line"));
      expect(el.scrollTop).toBe(1038);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves a reader who scrolled up where they are when a line grows", () => {
    const sizes = observeSizes();
    try {
      render(<Lines />);
      const el = screen.getByTestId("list");
      metrics(el, { scrollHeight: 1000, clientHeight: 200 });
      el.scrollTop = 100;
      fireEvent.scroll(el);
      metrics(el, { scrollHeight: 1038, clientHeight: 200 });
      sizes.resized(screen.getByTestId("line"));
      expect(el.scrollTop).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not scroll away from a row the reader opened at the bottom", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout"] });
    const sizes = observeSizes();
    try {
      render(<Lines />);
      const el = screen.getByTestId("list");
      metrics(el, { scrollHeight: 1000, clientHeight: 200 });
      sizes.resized(el);
      expect(el.scrollTop).toBe(1000);
      const tool = screen.getByTestId("tool");
      fireEvent.click(tool.querySelector("summary")!);
      metrics(el, { scrollHeight: 1400, clientHeight: 200 });
      sizes.resized(tool);
      expect(el.scrollTop).toBe(1000);
      // Once the opening has laid out, later growth is followed again.
      vi.advanceTimersByTime(100);
      metrics(el, { scrollHeight: 1438, clientHeight: 200 });
      sizes.resized(screen.getByTestId("line"));
      expect(el.scrollTop).toBe(1438);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("scrolls to the bottom while the reader is there", () => {
    const { rerender } = render(<List n={1} />);
    const el = screen.getByTestId("list");
    metrics(el, { scrollHeight: 1000, clientHeight: 400 });
    rerender(<List n={2} />);
    expect(el.scrollTop).toBe(1000);
    expect(screen.queryByText("New messages")).toBeNull();
  });

  it("stays put once the reader scrolls up, offers a jump, and follows again after it", () => {
    const { rerender } = render(<List n={1} />);
    const el = screen.getByTestId("list");
    metrics(el, { scrollHeight: 1000, clientHeight: 400 });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    metrics(el, { scrollHeight: 1400, clientHeight: 400 });
    rerender(<List n={2} />);
    expect(el.scrollTop).toBe(100);
    act(() => fireEvent.click(screen.getByText("New messages")));
    expect(el.scrollTop).toBe(1400);
    expect(screen.queryByText("New messages")).toBeNull();
  });

  it("snaps back to the bottom when the reader sends, and keeps following the reply", () => {
    const { rerender } = render(<List n={1} sent={0} />);
    const el = screen.getByTestId("list");
    metrics(el, { scrollHeight: 1000, clientHeight: 400 });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    rerender(<List n={1} sent={1} />);
    expect(el.scrollTop).toBe(1000);
    // The sent message and the reply land after the send; the list follows them.
    metrics(el, { scrollHeight: 1300, clientHeight: 400 });
    rerender(<List n={2} sent={1} />);
    expect(el.scrollTop).toBe(1300);
    expect(screen.queryByText("New messages")).toBeNull();
  });
});

describe("subagent threads opened", () => {
  function Seen({ session, stored, save }: { session: string; stored?: string[]; save: (s: string, id: string) => Promise<unknown> }) {
    const { seen, markSeen } = useSeen(session, stored, save);
    return <button onClick={() => markSeen("t2")}>{[...seen].sort().join(",") || "none"}</button>;
  }

  it("starts from what the session kept, so a restart does not mark them new again, and saves each one opened", async () => {
    const saved: string[] = [];
    const save = async (s: string, id: string) => saved.push(`${s}:${id}`);
    render(<Seen session="s1" stored={["t1"]} save={save} />);
    expect(screen.getByRole("button").textContent).toBe("t1");
    act(() => fireEvent.click(screen.getByRole("button")));
    expect(screen.getByRole("button").textContent).toBe("t1,t2");
    act(() => fireEvent.click(screen.getByRole("button")));
    expect(saved).toEqual(["s1:t2"]);
  });
});
