/**
 * System back as one stack. Every screen, sheet, drawer, menu and picker that
 * back should close registers here while it is up; a press runs the top one.
 * Depth comes from <BackLayer>: a nested screen outranks the screen around it
 * whatever order their effects ran in, and an overlay outranks every screen.
 * At the root, back leaves the app only on a second press within EXIT_MS,
 * after a "Press back again to exit" toast.
 */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BackHandler, Platform, View } from "react-native";
import { systemToast } from "./native/toast";
import { T } from "./ui/Text";
import { useTheme } from "./ui/ThemeProvider";

/** The second press that leaves must come within this long of the first. */
export const EXIT_MS = 2000;
export const EXIT_TOAST = "Press back again to exit";
/** Overlays (sheets, drawers, menus, pickers, the PIN prompt) sit this far above the screen they open over. */
const OVERLAY = 1000;

interface Entry {
  depth: number;
  seq: number;
  run: () => boolean;
}

const entries = new Set<Entry>();
let seq = 0;
let sub: { remove(): void } | null = null;
let armedAt = 0;

/**
 * The web harness has no back button (react-native-web's BackHandler only
 * complains), so there it listens only to a component test's mocked one.
 */
function hasBackButton(): boolean {
  if (typeof BackHandler?.addEventListener !== "function") return false;
  return Platform.OS !== "web" || "mock" in BackHandler.addEventListener;
}
function listen(): void {
  if (sub || !hasBackButton()) return;
  sub = BackHandler.addEventListener("hardwareBackPress", pressBack);
}
function unlisten(): void {
  if (entries.size > 0) return;
  sub?.remove();
  sub = null;
}

/** One back press: the top handler that takes it, or false to let the system have it (leave the app). */
export function pressBack(): boolean {
  const order = [...entries].sort((a, b) => b.depth - a.depth || b.seq - a.seq);
  for (const e of order) if (e.run()) return true;
  return false;
}

const DepthContext = createContext(0);

/** Screens inside this one go back before it. */
export function BackLayer({ children }: { children: ReactNode }) {
  const depth = useContext(DepthContext);
  return <DepthContext.Provider value={depth + 1}>{children}</DepthContext.Provider>;
}

/**
 * Back runs `handler` while it is set (null: not registered). It returns
 * whether it took the press; returning false passes it down the stack.
 */
export function useBack(handler: (() => boolean | void) | null, opts: { overlay?: boolean } = {}): void {
  const depth = useContext(DepthContext) + (opts.overlay ? OVERLAY : 0);
  const latest = useRef(handler);
  latest.current = handler;
  const on = handler !== null;
  useEffect(() => {
    if (!on) return;
    const e: Entry = { depth, seq: ++seq, run: () => latest.current?.() !== false };
    entries.add(e);
    listen();
    return () => {
      entries.delete(e);
      unlisten();
    };
  }, [on, depth]);
}

// The in-app toast for platforms without ToastAndroid.
let toast: string | null = null;
const toastListeners = new Set<() => void>();
function showToast(text: string | null): void {
  toast = text;
  toastListeners.forEach((l) => l());
}

/**
 * At a root: the first back press says how to leave and is taken; a second
 * within EXIT_MS is not, so the system closes the app.
 */
export function useBackExit(active: boolean): void {
  useBack(
    active
      ? () => {
          const now = Date.now();
          if (armedAt && now - armedAt < EXIT_MS) {
            armedAt = 0;
            showToast(null);
            return false;
          }
          armedAt = now;
          if (!systemToast(EXIT_TOAST)) showToast(EXIT_TOAST);
          return true;
        }
      : null,
  );
}

/** The exit toast where the system has none: over the foot of the screen for EXIT_MS. */
export function BackToast() {
  const text = useSyncExternalStore(
    (l) => (toastListeners.add(l), () => void toastListeners.delete(l)),
    () => toast,
  );
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    setShown(text);
    if (!text) return;
    const t = setTimeout(() => showToast(null), EXIT_MS);
    return () => clearTimeout(t);
  }, [text]);
  return shown ? <ToastView text={shown} /> : null;
}

function ToastView({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 48, alignItems: "center", zIndex: 100 }}>
      <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: t.c.line, backgroundColor: t.c.panel3 }}>
        <T style={{ color: t.c.text, fontSize: 13 }}>{text}</T>
      </View>
    </View>
  );
}

/** Tests: forget a pending first press. */
export function resetBack(): void {
  armedAt = 0;
  showToast(null);
}
