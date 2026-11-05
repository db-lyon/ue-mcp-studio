/** .attach-remove in the composer: a 44 pixel target with a 15 pixel cross in the middle. */
import { Pressable, Text } from "react-native";
import { font } from "./Text";
import { useTheme } from "./ThemeProvider";

export function RemoveButton({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [{ width: 44, minWidth: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radius }, pressed && { backgroundColor: t.c.panel3 }]}>
      {({ pressed }) => <Text style={[t.editor ? font(t, "sans", 400, 15, 1.2) : font(t, "mono", 500, 15, 1.2), { color: pressed ? t.c.text : t.c.muted }]}>{"×"}</Text>}
    </Pressable>
  );
}

