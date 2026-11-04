/** A /flow's card in the transcript: its steps as they run, then its summary or errors. */
import { StyleSheet, Text, View } from "react-native";
import { flowStateLine, type FlowEntry } from "@ue-mcp-studio/client-core";
import { font, useTheme } from "../../ui";
import { monoFont, smallFont } from "../../ui/type";

export function FlowCard({ entry }: { entry: FlowEntry }) {
  const t = useTheme();
  const failed = entry.state === "failed";
  const stopped = entry.state === "stopped";
  const tone = failed ? { backgroundColor: t.c.badWash, borderColor: t.c.badLine } : stopped ? { backgroundColor: t.c.warnWash, borderColor: t.c.warnLine } : { backgroundColor: t.c.panel2, borderColor: t.c.line };
  const color = failed ? t.c.badText : stopped ? t.c.warnText : t.c.text;
  const small = smallFont(t);
  const mono = monoFont(t, 12);
  // An ol's markers: the number, right-aligned in the list's 20 point gutter.
  return (
    <View testID="flow-card" accessibilityRole="summary" accessibilityLabel={`Flow ${entry.name}`} style={[s.card, tone]}>
      <View style={s.row}>
        <Text style={[monoFont(t, t.base.size, 700), { color }]}>{entry.name}</Text>
        <Text style={[small, { color: t.c.dim }]}>{flowStateLine(entry)}</Text>
      </View>
      {entry.steps.length > 0 ? (
        <View>
          {entry.steps.map((st, i) => {
            const c = st.state === "done" ? t.c.ok : st.state === "failed" ? t.c.bad : color;
            const weight = st.state === "running" ? 600 : 400;
            return (
              <View key={st.id} style={[s.item, { marginLeft: (st.depth ?? 0) * 14, opacity: st.state === "skipped" ? 0.55 : 1 }]}>
                <Text style={[smallFont(t, weight), { color: c, width: 20, paddingRight: 3, textAlign: "right" }]}>{i + 1}.</Text>
                <Text style={[smallFont(t, weight), { color: c, flex: 1, minWidth: 0 }]}>
                  <Text style={[mono, weight === 600 ? monoFont(t, 12, 600) : null]}>{st.name}</Text>
                  {st.state === "skipped" ? <Text style={{ color: t.c.dim }}> skipped</Text> : null}
                  {st.error ? <Text> {st.error}</Text> : null}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {entry.errors && entry.errors.length > 0 ? (
        entry.errors.length === 1 ? (
          <Text style={[small, { color }]}>{entry.errors[0]}</Text>
        ) : (
          <View style={s.ul}>
            {entry.errors.map((e, i) => (
              <View key={i} style={s.item}>
                <View style={s.disc}>
                  <View style={{ width: 4.5, height: 4.5, borderRadius: 2.25, backgroundColor: color }} />
                </View>
                <Text style={[small, { color, flex: 1, minWidth: 0 }]}>{e}</Text>
              </View>
            ))}
          </View>
        )
      ) : null}
      {entry.summary ? (
        <View style={[s.pre, { backgroundColor: t.c.codeBg, borderColor: t.c.line }]}>
          <Text selectable style={[font(t, "mono", 400, 12), { lineHeight: 19.2, color: t.c.codeText }]}>
            {entry.summary}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { flexDirection: "column", gap: 6, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 10, borderWidth: 1, borderRadius: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", marginVertical: 6 },
  item: { flexDirection: "row", alignItems: "flex-start" },
  ul: { marginVertical: 12 },
  // A ul's disc, where the browser draws it in the 40 point gutter.
  disc: { width: 40, height: 18.6, alignItems: "flex-end", justifyContent: "center", paddingRight: 9.5 },
  pre: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
});
