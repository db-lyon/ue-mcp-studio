/**
 * Sheet.tsx: a panel that slides up over a 55% scrim, a grip, the title and
 * Close; at most 70% of the screen, its body scrolling. It closes from Close,
 * a tap on the scrim, the system back, or the grip dragged down, and slides
 * out the way it came in (`.sheet`'s 240 ms transform, `.sheet-scrim`'s fade).
 */
import { useBack } from "../back";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Modal, PanResponder, Pressable, ScrollView, StyleSheet, View, type PanResponderCallbacks } from "react-native";
import { Button, Spacer } from "./controls";
import { useSheetInsets } from "./insets";
import { T } from "./Text";
import { useTheme } from "./ThemeProvider";

/** `.sheet`'s transition: 240 ms on cubic-bezier(0.2, 0.8, 0.2, 1); the scrim fades on `ease`. */
export const SHEET_MS = 240;
const SLIDE = Easing.bezier(0.2, 0.8, 0.2, 1);
const FADE = Easing.bezier(0.25, 0.1, 0.25, 1);

/**
 * When a drag on the grip closes the sheet: pulled down past a quarter of its
 * height (at least 80 px), or flicked down faster than 0.5 px/ms.
 */
export function dragCloses(dy: number, vy: number, height: number): boolean {
  return dy > Math.max(80, height * 0.25) || (dy > 10 && vy > 0.5);
}

/**
 * The grip's gesture handlers. A tap still reaches Close; a mostly vertical
 * move takes the gesture, the sheet follows the finger down (never up), and
 * on release it closes or springs back.
 */
export function sheetDragHandlers(o: { drag: Animated.Value; height: () => number; onClose: () => void }): PanResponderCallbacks {
  const back = () => Animated.spring(o.drag, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
  return {
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_e, g) => o.drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => (dragCloses(g.dy, g.vy, o.height()) ? o.onClose() : back()),
    onPanResponderTerminate: back,
  };
}

/** The head's spacing: grip to title row, title row to the body, and Close's drawn height (its taps reach 44). */
export const SHEET_HEAD = { top: 8, bottom: 4, close: 28 } as const;

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const t = useTheme();
  // Its actions end above the navigation bar, or above the keyboard while one of its fields has it up.
  const insets = useSheetInsets();
  const slide = useRef(new Animated.Value(open ? 1 : 0)).current;
  const scrim = useRef(new Animated.Value(open ? 1 : 0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const [height, setHeight] = useState(600);
  const heightRef = useRef(height);
  heightRef.current = height;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Mounted while it slides out, as the web keeps .sheet-root visible for the transition.
  const [mounted, setMounted] = useState(open);
  useBack(open ? onClose : null, { overlay: true });

  useEffect(() => {
    let live = true;
    if (open) {
      drag.setValue(0);
      setMounted(true);
    }
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (!live) return;
        const duration = reduce ? 0 : SHEET_MS;
        Animated.parallel([
          Animated.timing(slide, { toValue: open ? 1 : 0, duration, easing: SLIDE, useNativeDriver: true }),
          Animated.timing(scrim, { toValue: open ? 1 : 0, duration, easing: FADE, useNativeDriver: true }),
        ]).start(({ finished }) => {
          if (finished && !open && live) setMounted(false);
        });
      });
    return () => void (live = false);
  }, [open, slide, scrim, drag]);

  const pan = useMemo(() => PanResponder.create(sheetDragHandlers({ drag, height: () => heightRef.current, onClose: () => closeRef.current() })), [drag]);
  const translateY = Animated.add(slide.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }), drag);

  return (
    <Modal visible={open || mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Animated.View pointerEvents={open ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.55)", opacity: scrim }]}>
        <Pressable testID="sheet-scrim" accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={title}
        pointerEvents={open ? "box-none" : "none"}
        onLayout={(e) => setHeight(Math.max(1, e.nativeEvent.layout.height))}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "70%",
          paddingTop: 6,
          paddingLeft: 10 + insets.left,
          paddingRight: 10 + insets.right,
          paddingBottom: 12 + insets.bottom,
          backgroundColor: t.c.panel,
          borderTopWidth: 1,
          borderTopColor: t.c.lineStrong,
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          transform: [{ translateY }],
        }}
      >
        {/* .sheet-head: the grip and the title row take the drag; Close keeps its tap. */}
        {/* Tighter than the web's .sheet-head (owner, device build 6): no band between the grip and the title, or under it. */}
        <View testID="sheet-handle" {...pan.panHandlers} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: SHEET_HEAD.top, paddingHorizontal: 4, paddingBottom: SHEET_HEAD.bottom }}>
          <View testID="sheet-grip" style={{ position: "absolute", top: 0, left: "50%", width: 36, height: 4, marginLeft: -18, borderRadius: 2, backgroundColor: t.c.lineStrong }} />
          <T weight={700} size={t.base.size} numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </T>
          <Spacer />
          {/* Drawn 28 px tall, taking taps over 44. */}
          <Button title="Close" variant="ghost" onPress={onClose} hitSlop={8} style={{ minHeight: SHEET_HEAD.close, paddingVertical: 0 }} />
        </View>
        <ScrollView style={{ minHeight: 0 }}>{children}</ScrollView>
      </Animated.View>
    </Modal>
  );
}
