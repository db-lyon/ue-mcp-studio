/**
 * The changed files and one file's diff, as client-web's changes panel draws
 * them at phone width: the list (flat or a folder tree) alone, and a file
 * opens its diff in place of the list until Back. Android back goes from the
 * diff to the list, then closes.
 */
import { useEffect, useMemo, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { VcsChange, VcsStatus } from "@ue-mcp-studio/shared";
import { VCS_LETTER, baseName, buildTree, dirName, folderPaths, treeRows, vcsLine } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../nav";
import { Button, font, labelFont, useInsets, useStyles, useTheme, type Theme } from "../../ui";

export type ChangesView = "list" | "tree";
export const VIEW_KEY = "changes.view";

/** color-mix(in srgb, <hex> pct%, transparent). */
const mix = (hex: string, pct: number): string => {
  if (!hex.startsWith("#")) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${pct / 100})`;
};

const statusColor = (t: Theme, s: VcsChange["status"]): string => (s === "modified" || s === "renamed" ? t.c.warn : s === "added" || s === "untracked" ? t.c.ok : t.c.bad);

export function ChangesSheet({ vcs, onClose }: { vcs: VcsStatus; onClose: () => void }) {
  const { api } = useProjectNav();
  const t = useTheme();
  const s = useStyles(styles);
  const insets = useInsets();
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
  // The phone's own edges, which the web page never has (the visual QA page gives zero).
  const pad = insets;

  return (
    <Modal transparent animationType="none" visible statusBarTranslucent navigationBarTranslucent onRequestClose={() => (drilled ? setPicked(null) : onClose())}>
      <View style={[s.backdrop, { paddingTop: 8 + pad.top, paddingBottom: 8 + pad.bottom, paddingLeft: 8 + pad.left, paddingRight: 8 + pad.right }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close the changes" />
        <View style={s.panel} testID="changes-panel" aria-label="Changes" role="dialog">
          {drilled ? (
            <View style={s.detailHead}>
              <Button variant="ghost" label="Back to the changed files" onPress={() => setPicked(null)} style={s.back}>
                <Text style={s.backMark}>{"‹"}</Text>
                <Text style={s.backLabel}>Changes</Text>
              </Button>
              <Text style={s.detailName} numberOfLines={1}>
                {baseName(picked)}
              </Text>
              <Button variant="ghost" title="Close" onPress={onClose} />
            </View>
          ) : (
            <View style={s.head}>
              <View style={s.headTop}>
                <Text style={[labelFont(t), { flexShrink: 1 }]} accessibilityRole="header">
                  Changes
                </Text>
                <Button variant="ghost" title="Close" onPress={onClose} />
              </View>
              <Text style={s.small}>
                {vcs.name}, {vcsLine(vcs)}
              </Text>
            </View>
          )}
          {changes === null ? <Text style={s.note}>Loading</Text> : null}
          {changes?.length === 0 ? <Text style={s.note}>No changes.</Text> : null}
          {changes && changes.length > 0 && !drilled ? (
            <View style={s.toolbar}>
              <View style={s.seg} aria-label="Show changes as" role="group">
                {(["list", "tree"] as const).map((k, i) => (
                  <Pressable
                    key={k}
                    accessibilityRole="button"
                    accessibilityState={{ selected: view === k }}
                    aria-pressed={view === k}
                    onPress={() => pickView(k)}
                    style={[s.segButton, i > 0 && s.segNext, view === k && s.segOn]}
                  >
                    <Text style={[s.segText, view === k && { color: t.c.text }]}>{k === "list" ? "List" : "Tree"}</Text>
                  </Pressable>
                ))}
              </View>
              {view === "tree" && folders.length > 0 ? (
                <>
                  <Button variant="ghost" size="small" label="Expand all" onPress={() => setCollapsed(new Set())}>
                    <Text style={s.toolText}>Expand all</Text>
                  </Button>
                  <Button variant="ghost" size="small" label="Collapse all" onPress={() => setCollapsed(new Set(folders))}>
                    <Text style={s.toolText}>Collapse all</Text>
                  </Button>
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
                        <Text style={[s.rowText, s.status, { color: statusColor(t, c.status) }]}>{VCS_LETTER[c.status]}</Text>
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
                          <Text style={[s.rowText, s.status, s.chevron]}>{collapsed.has(r.path) ? "▸" : "▾"}</Text>
                          <Text style={[s.rowText, s.shrink, { color: t.c.muted }]} numberOfLines={1}>
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
                          <Text style={[s.rowText, s.status, { color: statusColor(t, r.change.status) }]}>{VCS_LETTER[r.change.status]}</Text>
                          <Text style={[s.rowText, s.shrink]} numberOfLines={1}>
                            {baseName(r.change.path)}
                          </Text>
                        </Pressable>
                      ),
                    )}
                {truncated ? <Text style={s.small}>More files changed than are listed.</Text> : null}
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
  const t = useTheme();
  const s = useStyles(styles);
  if (GIT_HEADER.test(line)) return <Text style={[s.diff, { color: t.c.dim }]} numberOfLines={1}>{line}</Text>;
  if (line.startsWith("@@")) return <Text style={[s.diff, { color: t.c.accentHi }]} numberOfLines={1}>{line}</Text>;
  const op = line[0] === "+" || line[0] === "-" || line[0] === " " ? line[0] : "";
  const color = op === "+" ? t.c.ok : op === "-" ? t.c.bad : t.c.text;
  return (
    <View style={[s.diffLine, op === "+" && { backgroundColor: t.c.okWash }, op === "-" && { backgroundColor: t.c.badWash }]}>
      <Text style={[s.diff, s.op, { color }]}>{op}</Text>
      <Text style={[s.diff, s.diffText, { color, borderLeftColor: mix(color, 30) }]} selectable>
        {op ? line.slice(1) : line}
      </Text>
    </View>
  );
}

const styles = (t: Theme) => {
  const lh = t.base.lineHeight / t.base.size;
  // A button's own type: mono in the ue-mcp theme, the editor's sans in the others.
  const button = t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23 };
  // The rows are buttons too: 12px mono at its normal line in ue-mcp, the editor's button type otherwise.
  const row = t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 400, 12), lineHeight: 16, letterSpacing: 0.24 };
  const tint = `linear-gradient(180deg, ${t.c.tint}, transparent 120px)`;
  return {
    backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.5)" },
    panel: {
      flex: 1,
      padding: 12,
      gap: 10,
      backgroundColor: t.c.panel,
      borderWidth: 1,
      borderColor: t.editor ? "transparent" : t.c.line,
      borderRadius: t.radiusLg,
      ...(Platform.OS === "web" ? { backgroundImage: tint } : { experimental_backgroundImage: tint }),
      boxShadow: "0 16px 48px rgba(0, 0, 0, 0.45)",
    } as ViewStyle,
    head: { marginVertical: 6, gap: 2 },
    headTop: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 10 },
    small: { ...font(t, "sans", 400, 12, lh), color: t.c.dim },
    detailHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, marginVertical: 6 },
    back: { paddingHorizontal: 8, gap: 4 },
    backMark: t.editor ? { ...button, color: t.c.muted } : { ...font(t, "mono", 500, 16, 1.2), letterSpacing: 0.32, color: t.c.muted },
    backLabel: { ...font(t, "mono", 500, 12), lineHeight: 12, letterSpacing: t.editor ? 0 : 0.32, color: t.c.muted },
    detailName: { ...font(t, "sans", 600, t.base.size), lineHeight: t.base.lineHeight, color: t.c.text, flex: 1, minWidth: 0, textAlign: "center" as const },
    note: { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: t.c.muted, marginVertical: t.base.size },
    // The path line's 6px margin and the note's collapse on the web into the note's own.
    afterFile: { marginTop: t.base.size - 6 },
    toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 8, marginVertical: 6 },
    seg: { flexDirection: "row" as const, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, overflow: "hidden" as const },
    segButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 5, justifyContent: "center" as const, alignItems: "center" as const },
    segNext: { borderLeftWidth: 1, borderLeftColor: t.c.lineStrong },
    segOn: { backgroundColor: t.c.accentWash, boxShadow: `inset 0 -2px 0 ${t.c.accent}` } as ViewStyle,
    segText: { ...button, color: t.c.muted },
    // small-button takes the panel's font size in ue-mcp; the editor themes set every button's.
    toolText: t.editor ? { ...button, color: t.c.muted } : { ...font(t, "mono", 500, t.base.size, 1.2), letterSpacing: 0.27, color: t.c.muted, marginTop: 1 },
    body: { flex: 1, minHeight: 0 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 44, paddingVertical: 4, paddingHorizontal: 8, borderRadius: t.radius },
    rowText: { ...row, color: t.c.text },
    status: { width: 16, textAlign: "center" as const, flexShrink: 0, ...font(t, t.editor ? "sans" : "mono", 700, 12) },
    chevron: { color: t.c.dim, ...font(t, t.editor ? "sans" : "mono", 400, 12) },
    shrink: { flexShrink: 1, minWidth: 0 },
    dir: { flexShrink: 1, minWidth: 0, fontSize: 11, lineHeight: t.editor ? 13.2 : 14, color: t.c.dim },
    count: { marginLeft: "auto" as const, paddingHorizontal: 6, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 9, flexShrink: 0 },
    countText: { fontSize: 11, lineHeight: 16, color: t.c.dim },
    file: { ...font(t, "mono", 400, 12), lineHeight: 12 * lh, color: t.c.dim, marginBottom: 6 },
    diff: { ...font(t, "mono", 400, 12), lineHeight: 18 },
    diffLine: { flexDirection: "row" as const },
    op: { width: t.editor ? 9.9 : 10.8 },
    diffText: { flex: 1, minWidth: 0, paddingLeft: 6, borderLeftWidth: 1 },
  };
};
