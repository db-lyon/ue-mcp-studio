/**
 * A menu beside a composer control is placed from where the control is on
 * screen. A tap on it while typing closes the keyboard, and the composer drops
 * by the keyboard's height after the place was read: the menu must follow.
 */
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Pressable, Text } from "react-native";
import { SETTLE_MS, useAnchor } from "../src/ui/anchor";
import { menuPlace } from "../src/screens/chat/composer/ModelPicker";
import { setKeyboardHeight } from "../src/native/keyboard.web";

const WIN = { width: 360, height: 804 };
const INSETS = { top: 24, bottom: 48, left: 0, right: 0 };
const KEYBOARD = 300;
/** Where the pill sits: on the keys while they are up, above the navigation bar when they are down. */
const pillY = (keyboard: number) => 700 - keyboard;

describe("the menu's place beside its button", () => {
  it("opens above the button, from the button's place with the keyboard up and with it down", () => {
    const up = menuPlace({ x: 60, y: pillY(KEYBOARD), width: 140, height: 44 }, { win: WIN, insets: INSETS, up: true, narrowest: false });
    expect((up as { bottom?: number }).bottom).toBe(WIN.height - pillY(KEYBOARD) + 6);
    const down = menuPlace({ x: 60, y: pillY(0), width: 140, height: 44 }, { win: WIN, insets: INSETS, up: true, narrowest: false });
    expect((down as { bottom?: number }).bottom).toBe(WIN.height - pillY(0) + 6);
    // Never past the status bar.
    expect(down.maxHeight).toBeLessThanOrEqual(pillY(0) - 6 - INSETS.top);
  });
});

function Probe() {
  const ref = useRef({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(60, pillY(keyboardNow), 140, 44) });
  const a = useAnchor(ref);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Open" onPress={a.open}>
      <Text testID="y">{a.anchor ? String(a.anchor.y) : "closed"}</Text>
    </Pressable>
  );
}
let keyboardNow = 0;

describe("useAnchor", () => {
  it("reads the button's place again when the keyboard closes under the tap", () => {
    vi.useFakeTimers();
    try {
      keyboardNow = KEYBOARD;
      setKeyboardHeight(KEYBOARD);
      render(<Probe />);
      fireEvent.click(screen.getByLabelText("Open"));
      expect(screen.getByTestId("y").textContent).toBe(String(pillY(KEYBOARD)));
      // The tap blurred the box: the keyboard goes and the composer drops.
      keyboardNow = 0;
      act(() => setKeyboardHeight(0));
      act(() => void vi.advanceTimersByTime(SETTLE_MS));
      expect(screen.getByTestId("y").textContent).toBe(String(pillY(0)));
      // And again when it comes back.
      keyboardNow = KEYBOARD;
      act(() => setKeyboardHeight(KEYBOARD));
      act(() => void vi.advanceTimersByTime(SETTLE_MS));
      expect(screen.getByTestId("y").textContent).toBe(String(pillY(KEYBOARD)));
    } finally {
      vi.useRealTimers();
      keyboardNow = 0;
    }
  });
});
