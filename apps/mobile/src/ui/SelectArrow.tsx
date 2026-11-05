/**
 * The arrow a phone's browser draws at the end of a <select> under
 * `color-scheme: dark`: a chevron in the text colour, 4px in from the box's
 * right edge and centred on it. A select in the app is a pressable row that
 * puts this at its end, so it reads as the web's.
 */
import Svg, { Polyline } from "react-native-svg";
import { View } from "react-native";
import { useTheme } from "./ThemeProvider";

export function SelectArrow() {
  const t = useTheme();
  return (
    <View pointerEvents="none" style={{ position: "absolute", right: 3, top: "50%", marginTop: -3, width: 10, height: 7 }}>
      <Svg width={10} height={7} viewBox="0 0 10 7">
        <Polyline points="1.4,1.4 5,5.4 8.6,1.4" fill="none" stroke={t.c.text} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </View>
  );
}
