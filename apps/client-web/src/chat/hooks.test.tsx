// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useFollow } from "./hooks";

afterEach(cleanup);

/** A list whose scroll metrics the test sets, since jsdom lays nothing out. */
function List({ n }: { n: number }) {
  const f = useFollow<HTMLDivElement>(n);
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
});
