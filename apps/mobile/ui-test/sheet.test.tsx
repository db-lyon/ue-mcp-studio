/**
 * src/ui Sheet closes four ways: Close, a tap on the scrim, the system back
 * (the Modal's onRequestClose, Escape in react-native-web) and the grip
 * dragged down. The drag's handlers are driven directly with the gestures a
 * finger produces, since jsdom has no touch layout.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Animated, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
import { dragCloses, Sheet, sheetDragHandlers } from "../src/ui";

const ev = {} as GestureResponderEvent;
const gesture = (g: Partial<PanResponderGestureState>): PanResponderGestureState => ({ stateID: 1, moveX: 0, moveY: 0, x0: 0, y0: 0, dx: 0, dy: 0, vx: 0, vy: 0, numberActiveTouches: 1, ...g });

function Host({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet open={open} title="Checkpoints" onClose={() => (onClose(), setOpen(false))}>
      <span>body</span>
    </Sheet>
  );
}

describe("Sheet closing", () => {
  it("closes from a tap on the scrim", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByTestId("sheet-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the system back", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.keyUp(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from Close", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const close = screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!;
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /** A finger on the grip moving from y 100 through `path`, 50 ms a step. */
  const dragHead = (...path: number[]) => {
    const head = screen.getByTestId("sheet-handle");
    let ts = 1000;
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", y: number) => {
      const t = { identifier: 0, pageX: 100, pageY: y, clientX: 100, clientY: y, screenX: 100, screenY: y, target: head };
      const list = type === "touchEnd" ? [] : [t];
      fireEvent[type](head, { touches: list, targetTouches: list, changedTouches: [t], timeStamp: (ts += 50) });
    };
    touch("touchStart", 100);
    for (const y of path) touch("touchMove", y);
    touch("touchEnd", path[path.length - 1]);
  };

  it("closes when a finger drags the grip down", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    dragHead(120, 150, 180, 210, 240, 270, 300);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when the finger comes back up before letting go", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    dragHead(120, 140, 160, 130, 105);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("slides out before it unmounts, as the web keeps it visible for the transition", async () => {
    vi.useFakeTimers();
    try {
      render(<Host onClose={() => undefined} />);
      fireEvent.click(screen.getByTestId("sheet-scrim"));
      expect(screen.queryByText("body")).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.queryByText("body")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Sheet drag to dismiss", () => {
  const make = (height = 400) => {
    const drag = new Animated.Value(0);
    const onClose = vi.fn();
    const h = sheetDragHandlers({ drag, height: () => height, onClose });
    const value = () => (drag as unknown as { __getValue(): number }).__getValue();
    return { drag, onClose, h, value };
  };

  it("leaves a tap to Close and takes a downward drag", () => {
    const { h } = make();
    expect(h.onStartShouldSetPanResponder!(ev, gesture({}))).toBe(false);
    expect(h.onMoveShouldSetPanResponder!(ev, gesture({ dy: 12, dx: 2 }))).toBe(true);
    // Sideways, or too small to be a drag, stays with what is under the finger.
    expect(h.onMoveShouldSetPanResponder!(ev, gesture({ dy: 6, dx: 20 }))).toBe(false);
    expect(h.onMoveShouldSetPanResponder!(ev, gesture({ dy: 2 }))).toBe(false);
    expect(h.onMoveShouldSetPanResponder!(ev, gesture({ dy: -30 }))).toBe(false);
  });

  it("follows the finger down and never above its open place", () => {
    const { h, value } = make();
    h.onPanResponderMove!(ev, gesture({ dy: 57 }));
    expect(value()).toBe(57);
    h.onPanResponderMove!(ev, gesture({ dy: -40 }));
    expect(value()).toBe(0);
  });

  it("closes when pulled past a quarter of its height", () => {
    const { h, onClose } = make(400);
    h.onPanResponderMove!(ev, gesture({ dy: 120 }));
    h.onPanResponderRelease!(ev, gesture({ dy: 120, vy: 0.1 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a quick flick down", () => {
    const { h, onClose } = make(400);
    h.onPanResponderRelease!(ev, gesture({ dy: 30, vy: 1.2 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("springs back from a short slow drag", async () => {
    const { h, onClose, value } = make(400);
    h.onPanResponderMove!(ev, gesture({ dy: 40 }));
    h.onPanResponderRelease!(ev, gesture({ dy: 40, vy: 0.1 }));
    expect(onClose).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 600));
    expect(value()).toBeLessThan(1);
  });

  it("does not hand the gesture to the list under it mid-drag", () => {
    const { h } = make();
    expect(h.onPanResponderTerminationRequest!(ev, gesture({}))).toBe(false);
  });

  it("the threshold: a quarter of the height, at least 80 px", () => {
    expect(dragCloses(79, 0, 200)).toBe(false);
    expect(dragCloses(81, 0, 200)).toBe(true);
    expect(dragCloses(150, 0, 800)).toBe(false);
    expect(dragCloses(201, 0, 800)).toBe(true);
    expect(dragCloses(8, 2, 800)).toBe(false);
  });
});
