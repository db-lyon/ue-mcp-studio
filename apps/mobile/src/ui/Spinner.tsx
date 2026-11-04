/**
 * .spinner and .spinner.small: a ring in the hairline colour with an accent
 * top, turning once every 0.8 s.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "./ThemeProvider";

export function Spinner({ small = false, style }: { small?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const size = small ? 12 : 16;
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: size,
          height: size,
          flexShrink: 0,
          borderWidth: 2,
          borderRadius: size / 2,
          borderColor: t.c.line,
          borderTopColor: t.c.accent,
          transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
        },
        style,
      ]}
    />
  );
}
