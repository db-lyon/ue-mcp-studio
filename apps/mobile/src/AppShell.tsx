// STUB: owned by shell
/** The narrow top bar (menu button and the tab's title) over the Chat tab, until the shell's port lands. */
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, T, useTheme } from "./ui";
import { Chat } from "./views/Chat";

export function AppShell({ initialSession = null, onBack }: { initialSession?: string | null; onBack?: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const line = <View style={{ width: 12, height: 1.4, borderRadius: 1, backgroundColor: t.c.text }} />;
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={{ height: 50 + insets.top, paddingTop: insets.top, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: Math.max(6, insets.left), paddingRight: Math.max(12, insets.right), backgroundColor: t.c.barBg, borderBottomWidth: 1, borderBottomColor: t.c.line, zIndex: 30 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Menu" onPress={onBack} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", gap: 2.6 }}>
          {line}
          {line}
          {line}
        </Pressable>
        <T style={{ ...font(t, "sans", 600, 15, 1.3), color: t.c.text }}>Chat</T>
      </View>
      <Chat initialSession={initialSession} />
    </View>
  );
}
