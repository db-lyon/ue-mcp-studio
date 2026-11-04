import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "./theme";

export function Center({ children }: { children: ReactNode }) {
  return <View style={s.center}>{children}</View>;
}

export function Spinner() {
  return <ActivityIndicator color={colors.accent} />;
}

export function Button({ title, onPress, primary, danger, disabled }: { title: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={({ pressed }) => [s.button, primary && s.primary, (pressed || disabled) && { opacity: 0.6 }]}>
      <Text style={[s.buttonText, primary && s.primaryText, danger && { color: colors.danger }]}>{title}</Text>
    </Pressable>
  );
}

export function Header({ title, back, onBack, right }: { title: string; back?: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={s.headerBar}>
        {onBack ? (
          <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
            <Text style={s.link}>{back ?? "Back"}</Text>
          </Pressable>
        ) : (
          <View />
        )}
        {right}
      </View>
      <Text style={s.title} numberOfLines={2}>
        {title}
      </Text>
    </View>
  );
}

export function Dot({ state }: { state: "on" | "off" | "error" | "busy" }) {
  const bg = state === "on" ? colors.ok : state === "error" ? colors.danger : state === "busy" ? colors.warn : colors.faint;
  return <View style={[s.dot, { backgroundColor: bg }]} />;
}

export const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  page: { flex: 1, paddingHorizontal: 20, paddingTop: 52, paddingBottom: 20 },
  headerBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 28, marginBottom: 4 },
  title: { color: colors.text, fontSize: 24, fontWeight: "600" },
  section: { color: colors.muted, fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 16, marginBottom: 6 },
  body: { color: colors.text, fontSize: 15, lineHeight: 21, marginBottom: 16 },
  sub: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 14, marginBottom: 12 },
  link: { color: colors.accent, fontSize: 15 },
  code: { color: colors.text, fontSize: 40, fontWeight: "700", letterSpacing: 4, marginVertical: 16, fontVariant: ["tabular-nums"] },
  input: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 8 },
  button: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center", marginTop: 8 },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  primaryText: { color: colors.onAccent },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  banner: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 10 },
});
