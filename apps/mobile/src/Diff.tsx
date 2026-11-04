/**
 * Line diffs: an approval's DiffLine[], and unified text diffs (a checkpoint's
 * or Git's) through shared's unifiedLines. Each line keeps its width and
 * scrolls sideways with the rest, so code never wraps mid-line.
 */
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { DiffLine } from "@ue-mcp-studio/shared";
import { colors, mono } from "./theme";

export function DiffView({ lines, label, max = 400 }: { lines: DiffLine[]; label: string; max?: number }) {
  const shown = lines.slice(0, max);
  const added = lines.filter((l) => l.op === "+").length;
  const removed = lines.filter((l) => l.op === "-").length;
  return (
    <View style={d.box} accessibilityLabel={`${label}: ${added} added, ${removed} removed`}>
      <ScrollView horizontal>
        <View>
          {shown.map((l, i) =>
            l.op === "gap" ? (
              <Text key={i} style={[d.line, d.gap]}>
                {l.count > 0 ? `⋯ ${l.count} unchanged ${l.count === 1 ? "line" : "lines"}` : "⋯"}
              </Text>
            ) : (
              <Text key={i} style={[d.line, l.op === "+" && d.add, l.op === "-" && d.del]} selectable>
                {l.op === " " ? "  " : `${l.op} `}
                {l.text}
              </Text>
            ),
          )}
        </View>
      </ScrollView>
      {lines.length > max ? <Text style={[d.line, d.gap]}>{lines.length - max} more lines not shown</Text> : null}
    </View>
  );
}

const d = StyleSheet.create({
  box: { backgroundColor: colors.code, borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingVertical: 6, marginVertical: 6 },
  line: { fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.codeText, paddingHorizontal: 8 },
  add: { backgroundColor: colors.diffAdd, color: colors.ok },
  del: { backgroundColor: colors.diffDel, color: colors.dangerText },
  gap: { color: colors.faint },
});
