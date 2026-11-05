/**
 * @keyframes pulse: a dot fading to 30% and back, 1.2s by default. Still when
 * the system asks for less motion, and in visual QA, which shoots animations at
 * full strength as the web harness freezes them.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewStyle } from "react-native";

const frozen = () => !!(globalThis as { __studioFreezeAnimations?: boolean }).__studioFreezeAnimations;

export function Pulse({ children, period = 1200, on = true, style }: { children?: ReactNode; period?: number; on?: boolean; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(1)).current;
  const [still, setStill] = useState(frozen());
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.().then((r) => alive && r && setStill(true)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!on || still) return v.setValue(1);
    const half = { duration: period / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true };
    const loop = Animated.loop(Animated.sequence([Animated.timing(v, { toValue: 0.3, ...half }), Animated.timing(v, { toValue: 1, ...half })]));
    loop.start();
    return () => loop.stop();
  }, [on, still, period, v]);
  return <Animated.View style={[style, { opacity: v }]}>{children}</Animated.View>;
}
