/**
 * The changed files and one file's diff, as client-web's changes panel draws
 * them at phone width: the list (flat or a folder tree) alone, and a file
 * opens its diff in place of the list until Back. Android back goes from the
 * diff to the list, then closes.
 */
import { useEffect, useMemo, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { VcsChange, VcsStatus } from "@ue-mcp-studio/shared";
import { VCS_LETTER, baseName, buildTree, dirName, folderPaths, treeRows, vcsLine } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../nav";
import { WebButton } from "../../ui/controls";
import { base, card, css, fonts, shadow, small } from "../../ui/css";

export type ChangesView = "list" | "tree";
export const VIEW_KEY = "changes.view";

const STATUS_COLOR: Record<VcsChange["status"], string> = { modified: css.warn, renamed: css.warn, added: css.ok, untracked: css.ok, deleted: css.bad, conflicted: css.bad };

export function ChangesSheet({ vcs, onClose }: { vcs: VcsStatus; onClose: () => void }) {
  const { api } = useProjectNav();
  const insets = useSafeAreaInsets();
  const [changes, setChanges] = useState<VcsChange[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ diff: string | null; reason?: string } | null>(null);
  const [view, setView] = useState<ChangesView>("list");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildTree(changes ?? []), [changes]);
  const folders = useMemo(() => folderPaths(tree), [tree]);

  useEffect(() => {
    SecureStore.getItemAsync(VIEW_KEY).then((v) => v === "tree" && setView("tree"), () => undefined);
  }, []);
  const pickView = (v: ChangesView) => {
    setView(v);
    void SecureStore.setItemAsync(VIEW_KEY, v).catch(() => undefined);
  };
  const toggle = (p: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  useEffect(() => {
    api.vcsChanges().then(
      (r) => {
        setChanges(r.changes);
        setTruncated(r.truncated);
      },
      () => setChanges([]),
    );
  }, [api]);

  useEffect(() => {
    if (!picked) return setDiff(null);
    let live = true;
    setDiff(null);
    api.vcsDiff(picked).then(
      (d) => live && setDiff(d),
      (e: Error) => live && setDiff({ diff: null, reason: e.message }),
    );
    return () => void (live = false);
  }, [api, picked]);

  const drilled = picked !== null;
  // The phone's own edges, which the web page never has.
  const pad = Platform.OS === "web" ? { top: 0, bottom: 0, left: 0, right: 0 } : insets;

  return (
    <Modal transparent animationType="none" visible onRequestClose={() => (drilled ? setPicked(null) : onClose())}>
      <View style={[s.backdrop, { paddingTop: 8 + pad.top, paddingBottom: 8 + pad.bottom, paddingLeft: 8 + pad.left, paddingRight: 8 + pad.right }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close the changes" />
        <View style={s.panel} testID="changes-panel" accessibilityRole="none" aria-label="Changes" role="dialog">
          {drilled ? (
            <View style={s.detailHead}>
              <WebButton kind="ghost" bare label="Back to the changed files" onPress={() => setPicked(null)} style={s.back}>
                <Text style={s.backMark}>{"‹"}</Text>
                <Text style={s.backLabel}>Changes</Text>
              </WebButton>
              <Text style={s.detailName} numberOfLines={1}>
                {baseName(picked)}
              </Text>
              <WebButton kind="ghost" bare title="Close" onPress={onClose} />
            </View>
          ) : (
            <View style={s.head}>
              <View style={s.headTop}>
                <Text style={s.h2} accessibilityRole="header">
                  Changes
                </Text>
                <WebButton kind="ghost" bare title="Close" onPress={onClose} />
              </View>
              <Text style={[base, small, { color: css.dim }]}>
                {vcs.name}, {vcsLine(vcs)}
              </Text>
            </View>
          )}
          {changes === null ? <Text style={s.note}>Loading</Text> : null}
          {changes?.length === 0 ? <Text style={s.note}>No changes.</Text> : null}
          {changes && changes.length > 0 && !drilled ? (
            <View style={s.toolbar}>
              <View style={s.seg} accessibilityRole="radiogroup" aria-label="Show changes as">
                {(["list", "tree"] as const).map((k, i) => (
                  <Pressable
                    key={k}
                    accessibilityRole="button"
                    accessibilityState={{ selected: view === k }}
                    aria-pressed={view === k}
                    onPress={() => pickView(k)}
                    style={[s.segButton, i > 0 && s.segNext, view === k && s.segOn]}
                  >
                    <Text style={[s.segText, view === k && { color: css.text }]}>{k === "list" ? "List" : "Tree"}</Text>
                  </Pressable>
                ))}
              </View>
              {view === "tree" && folders.length > 0 ? (
                <>
                  <WebButton kind="ghost" bare small title="Expand all" onPress={() => setCollapsed(new Set())} style={s.toolButton} textStyle={s.toolText} />
                  <WebButton kind="ghost" bare small title="Collapse all" onPress={() => setCollapsed(new Set(folders))} style={s.toolButton} textStyle={s.toolText} />
                </>
              ) : null}
            </View>
          ) : null}
          {changes && changes.length > 0 ? (
            drilled ? (
              <ScrollView style={s.body} testID="changes-diff">
                <Text style={s.file} selectable>
                  {picked}
                </Text>
                {!diff ? <Text style={[s.note, s.afterFile]}>Loading</Text> : null}
                {diff?.reason ? <Text style={[s.note, s.afterFile]}>{diff.reason}</Text> : null}
                {diff?.diff ? (
                  <View accessibilityLabel={`Changes to ${baseName(picked)}`}>
                    {diff.diff.split("\n").map((l, i) => (
                      <GitDiffLine key={i} line={l} />
                    ))}
                  </View>
                ) : null}
              </ScrollView>
            ) : (
              <ScrollView style={s.body} testID="changes-list">
                {view === "list"
                  ? changes.map((c) => (
                      <Pressable key={c.path} accessibilityRole="button" accessibilityLabel={`${c.status} ${c.path}`} onPress={() => setPicked(c.path)} style={s.row}>
                        <Text style={[s.rowText, s.status, { color: STATUS_COLOR[c.status] }]}>{VCS_LETTER[c.status]}</Text>
                        <Text style={[s.rowText, { flexShrink: 0 }]}>{baseName(c.path)}</Text>
                        <Text style={[s.rowText, s.dir]} numberOfLines={1}>
                          {dirName(c.path)}
                        </Text>
                      </Pressable>
                    ))
                  : treeRows(tree, collapsed).map((r) =>
                      r.kind === "folder" ? (
                        <Pressable
                          key={`d:${r.path}`}
                          accessibilityRole="button"
                          accessibilityLabel={r.path}
                          accessibilityState={{ expanded: !collapsed.has(r.path) }}
                          aria-expanded={!collapsed.has(r.path)}
                          onPress={() => toggle(r.path)}
                          style={[s.row, { paddingLeft: 8 + r.depth * 14 }]}
                        >
                          <Text style={[s.rowText, s.status, { color: css.dim }]}>{collapsed.has(r.path) ? "▸" : "▾"}</Text>
                          <Text style={[s.rowText, s.shrink, { color: css.muted }]} numberOfLines={1}>
                            {r.name}
                          </Text>
                          <View style={s.count}>
                            <Text style={[s.rowText, s.countText]}>{r.count}</Text>
                          </View>
                        </Pressable>
                      ) : (
                        <Pressable
                          key={r.change.path}
                          accessibilityRole="button"
                          accessibilityLabel={`${r.change.status} ${r.change.path}`}
                          onPress={() => setPicked(r.change.path)}
                          style={[s.row, { paddingLeft: 8 + r.depth * 14 }]}
                        >
                          <Text style={[s.rowText, s.status, { color: STATUS_COLOR[r.change.status] }]}>{VCS_LETTER[r.change.status]}</Text>
                          <Text style={[s.rowText, s.shrink]} numberOfLines={1}>
                            {baseName(r.change.path)}
                          </Text>
                        </Pressable>
                      ),
                    )}
                {truncated ? <Text style={[base, small, { color: css.dim }]}>More files changed than are listed.</Text> : null}
              </ScrollView>
            )
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/** A git diff's file header lines, cut to one line: the panel already names the file. */
const GIT_HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) )/;

/** One line of a git diff: a header or hunk on one line, or a change with its sign in a gutter and its text wrapped beside it. */
export function GitDiffLine({ line }: { line: string }) {
  if (GIT_HEADER.test(line)) return <Text style={[s.diff, { color: css.dim }]} numberOfLines={1}>{line}</Text>;
  if (line.startsWith("@@")) return <Text style={[s.diff, { color: css.accentHi }]} numberOfLines={1}>{line}</Text>;
  const op = line[0] === "+" || line[0] === "-" || line[0] === " " ? line[0] : "";
  const tone = op === "+" ? s.add : op === "-" ? s.del : null;
  const color = op === "+" ? css.ok : op === "-" ? css.bad : css.text;
  return (
    <View style={[s.diffLine, tone]}>
      <Text style={[s.diff, s.op, { color }]}>{op}</Text>
      <Text style={[s.diff, s.diffText, { color, borderLeftColor: op === "+" ? "rgba(108, 192, 139, 0.3)" : op === "-" ? "rgba(229, 96, 79, 0.3)" : "rgba(236, 233, 227, 0.3)" }]} selectable>
        {op ? line.slice(1) : line}
      </Text>
    </View>
  );
}

const mono12 = { fontFamily: fonts.mono, fontSize: 12, letterSpacing: 0.24 } as const;

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  panel: { ...card, flex: 1, padding: 12, gap: 10, ...shadow("0 16px 48px rgba(0, 0, 0, 0.45)") },
  head: { marginVertical: 6, gap: 2 },
  headTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  h2: { fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 13.65, fontWeight: "600", letterSpacing: 1.68, textTransform: "uppercase", color: css.accent, flexShrink: 1 },
  detailHead: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 6 },
  back: { paddingHorizontal: 8, gap: 4 },
  backMark: { fontFamily: fonts.mono, fontSize: 16, lineHeight: 19.2, fontWeight: "500", letterSpacing: 0.32, color: css.muted },
  backLabel: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 12, fontWeight: "500", letterSpacing: 0.32, color: css.muted },
  detailName: { ...base, flex: 1, minWidth: 0, fontWeight: "600", textAlign: "center" },
  note: { ...base, color: css.muted, marginVertical: 13.5 },
  // The path line's 6 point margin and the note's 13.5 collapse on the web: 13.5 in all.
  afterFile: { marginTop: 7.5 },
  toolbar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginVertical: 6 },
  seg: { flexDirection: "row", borderWidth: 1, borderColor: css.lineStrong, borderRadius: css.radius, overflow: "hidden" },
  segButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 5, justifyContent: "center", alignItems: "center" },
  segNext: { borderLeftWidth: 1, borderLeftColor: css.lineStrong },
  segOn: { backgroundColor: css.accentWash, ...shadow(`inset 0 -2px 0 ${css.accent}`) },
  segText: { fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 13.8, fontWeight: "500", letterSpacing: 0.23, color: css.muted },
  toolButton: { paddingHorizontal: 10 },
  toolText: { marginTop: 1, fontSize: 13.5, lineHeight: 16.2, letterSpacing: 0.27, color: css.muted },
  body: { flex: 1, minHeight: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingVertical: 4, paddingHorizontal: 8, borderRadius: css.radius },
  rowText: { ...mono12, lineHeight: 16, color: css.text },
  status: { width: 16, textAlign: "center", fontWeight: "700", flexShrink: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  dir: { flexShrink: 1, minWidth: 0, fontSize: 11, lineHeight: 14, color: css.dim },
  count: { marginLeft: "auto", paddingHorizontal: 6, borderWidth: 1, borderColor: css.lineStrong, borderRadius: 9, flexShrink: 0 },
  countText: { fontSize: 11, lineHeight: 16, color: css.dim },
  file: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18.6, color: css.dim, marginBottom: 6 },
  diff: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  diffLine: { flexDirection: "row" },
  op: { width: 10.8 },
  diffText: { flex: 1, minWidth: 0, paddingLeft: 6, borderLeftWidth: 1 },
  add: { backgroundColor: "rgba(108, 192, 139, 0.1)" },
  del: { backgroundColor: "rgba(229, 96, 79, 0.1)" },
});
