/**
 * Placeholders shaped like what is loading: session rows in the list, and a
 * conversation while a session opens. Through remote control every request
 * takes a moment, and an empty pane reads as broken.
 */
import { useEffect, useRef } from "react";
import { Animated, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../ui";

/** .skeleton-bar: a grey bar whose shade sweeps between panel-2 and panel-3. */
function Bar({ width, style }: { width: DimensionValue; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const shade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.timing(shade, { toValue: 1, duration: 700, useNativeDriver: false }), Animated.timing(shade, { toValue: 0, duration: 700, useNativeDriver: false })]));
    loop.start();
    return () => loop.stop();
  }, [shade]);
  const backgroundColor = shade.interpolate({ inputRange: [0, 1], outputRange: [t.c.panel2, t.c.panel3] });
  return <Animated.View style={[{ width, height: 11, borderRadius: 6, backgroundColor }, style]} />;
}

/** The session list before it first answers. */
export function SessionRowsLoading() {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading sessions">
      {[72, 54, 64].map((w, i) => (
        <View key={i} style={{ paddingVertical: 9, paddingHorizontal: 10, marginHorizontal: -4, marginBottom: 2, borderWidth: 1, borderColor: "transparent" }}>
          <Bar width={`${w}%`} />
          <Bar width={`${w - 22}%`} style={{ height: 8, marginTop: 7, opacity: 0.7 }} />
        </View>
      ))}
    </View>
  );
}

/** A session that is opening: a user line and a few agent lines. */
export function SessionLoading() {
  const msg: ViewStyle = { gap: 8, alignSelf: "flex-start", width: "86%", maxWidth: 560 };
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Opening session" style={{ flex: 1, gap: 16, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 10 }}>
      <View style={[msg, { alignSelf: "flex-end", width: "60%", maxWidth: 280 }]}>
        <Bar width="100%" style={{ height: 34, borderRadius: 10 }} />
      </View>
      <View style={msg}>
        <Bar width="92%" />
        <Bar width="78%" />
        <Bar width="54%" />
      </View>
      <View style={msg}>
        <Bar width="100%" style={{ height: 30, borderRadius: 8 }} />
      </View>
      <View style={msg}>
        <Bar width="86%" />
        <Bar width="40%" />
      </View>
    </View>
  );
}
