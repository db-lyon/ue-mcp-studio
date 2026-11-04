/**
 * The web client's chat/Pills.tsx for the app: the pill row right above the
 * composer. A tap runs the pill and clears the row. Nothing renders while
 * there are no pills. styles.css: .pill-row, .pill-suggestion.
 */
import { Pressable, ScrollView, Text } from "react-native";
import { font, useTheme } from "../ui";
import type { Pill, PillActions } from "./pill-providers";

export function PillRow({ pills, actions, onClear }: { pills: Pill[]; actions: PillActions; onClear: () => void }) {
  const t = useTheme();
  if (pills.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="toolbar" accessibilityLabel="Suggestions" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingTop: 4, paddingBottom: 6 }}>
      {pills.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          accessibilityLabel={p.label}
          accessibilityHint={p.title}
          onPress={() => {
            onClear();
            p.run(actions);
          }}
          style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", borderWidth: 1, borderColor: pressed ? t.c.accent : t.c.lineStrong, borderRadius: 999, paddingVertical: 2, paddingHorizontal: 10, backgroundColor: t.c.panel2 })}
        >
          <Text numberOfLines={1} style={[t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, 12, 1.2), letterSpacing: 0.24 }, { color: t.c.text }]}>{p.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
