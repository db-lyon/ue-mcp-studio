/**
 * Where a control sits on screen, for a menu drawn beside it in a Modal. The
 * place is read when the menu opens and read again while it is open whenever
 * the keyboard comes or goes or the window turns: a tap on a composer control
 * while typing closes the keyboard, and the composer drops by its height after
 * the place was first read.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useWindowDimensions } from "react-native";
import { useKeyboardHeight } from "../native/keyboard";

export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Measurable = { measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void };

/** How long after the keyboard moves the place is read once more, for the frames its slide takes. */
export const SETTLE_MS = 350;

/** `shown` turns on at once on open; `anchor` follows when the place has been read. */
export function useAnchor(ref: RefObject<unknown>): { anchor: Anchor | null; shown: boolean; open: () => void; close: () => void } {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [isShown, setShown] = useState(false);
  const shown = useRef(false);
  const keyboard = useKeyboardHeight();
  const win = useWindowDimensions();
  const measure = useCallback(() => {
    const el = ref.current as Measurable | null;
    if (!el?.measureInWindow) return setAnchor({ x: 0, y: 0, width: 0, height: 0 });
    el.measureInWindow((x, y, width, height) => shown.current && setAnchor({ x, y, width, height }));
  }, [ref]);
  const open = useCallback(() => {
    shown.current = true;
    setShown(true);
    measure();
  }, [measure]);
  const close = useCallback(() => {
    shown.current = false;
    setShown(false);
    setAnchor(null);
  }, []);
  useEffect(() => {
    if (!shown.current) return;
    measure();
    const t = setTimeout(measure, SETTLE_MS);
    return () => clearTimeout(t);
  }, [keyboard, win.width, win.height, measure]);
  return { anchor, shown: isShown, open, close };
}
