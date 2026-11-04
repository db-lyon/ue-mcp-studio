/** .spinner and .spinner.small: a ring with the accent on top, turning. */
import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";
import { useTheme } from "./ThemeProvider";

export function Spinner({ small, still }: { small?: boolean; still?: boolean }) {
  const t = useTheme();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [turn, still]);
  const size = small ? 12 : 16;
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      aria-hidden
      style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: t.c.line, borderTopColor: t.c.accent, flexShrink: 0, transform: [{ rotate }] }}
    />
  );
}
