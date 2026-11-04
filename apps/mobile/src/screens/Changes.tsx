/**
 * The project's source control: its branch and changed files, as a flat list
 * or a folder tree, each file opening to its diff. Read when opened, on pull,
 * and when a session changes (a turn may have changed files).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { VCS_LETTER, baseName, buildTree, dirName, treeRows, vcsLine, type TreeRow } from "@ue-mcp-studio/client-core";
import { unifiedLines, type VcsChange, type VcsStatus } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../nav";
import { DiffView } from "../Diff";
import { Header, s as ui, Spinner } from "../ui";
import { colors, mono } from "../theme";

const VIEW_KEY = "changes.view";
const STATUS_COLOR: Partial<Record<VcsChange["status"], string>> = { added: colors.ok, untracked: colors.ok, deleted: colors.danger, conflicted: colors.warn };

export function ChangesScreen() {
  const { api, pop, push, project } = useProjectNav();
  const [vcs, setVcs] = useState<VcsStatus | null | undefined>(undefined);
  const [changes, setChanges] = useState<VcsChange[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [view, setView] = useState<"list" | "tree">("list");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(VIEW_KEY).then((v) => v === "tree" && setView("tree"), () => undefined);
  }, []);
  const choose = (v: "list" | "tree") => {
    setView(v);
    void SecureStore.setItemAsync(VIEW_KEY, v).catch(() => undefined);
  };

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const v = (await api.vcs()).vcs;
      setVcs(v);
      if (v) {
        const c = await api.vcsChanges();
        setChanges(c.changes);
        setTruncated(c.truncated);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [api]);
  useEffect(() => void load(), [load]);
  useEffect(() => project.onEvent((e) => void (e.type === "studio.session.changed" && load())), [project, load]);

  const rows = useMemo<TreeRow[]>(() => (changes ? (view === "tree" ? treeRows(buildTree(changes), collapsed) : changes.map((change) => ({ kind: "file" as const, change, depth: 0 }))) : []), [changes, view, collapsed]);
  const toggle = (path: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <View style={ui.page}>
      <Header title="Changes" back="Sessions" onBack={pop} />
      {vcs ? <Text style={ui.sub}>{vcs.name}: {vcsLine(vcs)}</Text> : null}
      {vcs === null ? <Text style={[ui.sub, { marginTop: 12 }]}>This project has no source control Studio can read.</Text> : null}
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {vcs ? (
        <View style={v.seg} accessibilityRole="tablist">
          {(["list", "tree"] as const).map((k) => (
            <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: view === k }} onPress={() => choose(k)} style={[v.segItem, view === k && v.segOn]}>
              <Text style={[ui.sub, view === k && { color: colors.text, fontWeight: "600" }]}>{k === "list" ? "List" : "Tree"}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === "folder" ? `d:${r.path}` : `f:${r.change.path}`)}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.panel} />}
        ListEmptyComponent={changes ? <Text style={ui.sub}>No changes.</Text> : vcs === undefined ? <Spinner /> : undefined}
        ListFooterComponent={truncated ? <Text style={[ui.sub, { marginTop: 8 }]}>The list was cut short; more files changed.</Text> : undefined}
        renderItem={({ item }) =>
          item.kind === "folder" ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed.has(item.path) }} onPress={() => toggle(item.path)} style={[v.row, { paddingLeft: item.depth * 14 }]}>
              <Text style={v.chev}>{collapsed.has(item.path) ? "▸" : "▾"}</Text>
              <Text style={[ui.name, { flex: 1 }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={ui.sub}>{item.count}</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel={`${item.change.status} ${item.change.path}`} onPress={() => push({ name: "change", path: item.change.path })} style={[v.row, { paddingLeft: item.depth * 14 + (view === "tree" ? 18 : 0) }]}>
              <Text style={[v.letter, { color: STATUS_COLOR[item.change.status] ?? colors.warnText }]}>{VCS_LETTER[item.change.status]}</Text>
              <View style={{ flex: 1 }}>
                <Text style={ui.name} numberOfLines={1}>
                  {baseName(item.change.path)}
                </Text>
                {view === "list" && dirName(item.change.path) ? (
                  <Text style={[ui.sub, { fontFamily: mono, fontSize: 11 }]} numberOfLines={1}>
                    {dirName(item.change.path)}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          )
        }
      />
    </View>
  );
}

export function ChangeScreen({ path }: { path: string }) {
  const { api, pop } = useProjectNav();
  const [diff, setDiff] = useState<{ diff: string | null; reason?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.vcsDiff(path).then(
      (d) => live && setDiff(d),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [api, path]);
  const lines = diff?.diff ? unifiedLines(diff.diff) : null;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={ui.page}>
      <Header title={baseName(path)} back="Changes" onBack={pop} />
      <Text style={[ui.sub, { fontFamily: mono, fontSize: 11 }]} selectable>
        {path}
      </Text>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {!diff && !error ? (
        <View style={{ marginTop: 24 }}>
          <Spinner />
        </View>
      ) : null}
      {diff && !diff.diff ? <Text style={[ui.sub, { marginTop: 12 }]}>{diff.reason ?? "No text diff for this file."}</Text> : null}
      {lines ? <DiffView lines={lines} label={`Changes to ${baseName(path)}`} /> : null}
    </ScrollView>
  );
}

const v = StyleSheet.create({
  seg: { flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.border, borderRadius: 8, marginTop: 10, marginBottom: 4, overflow: "hidden" },
  segItem: { paddingHorizontal: 14, paddingVertical: 7 },
  segOn: { backgroundColor: colors.accentWash },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, minHeight: 44 },
  chev: { color: colors.muted, width: 14 },
  letter: { fontFamily: mono, fontSize: 13, fontWeight: "700", width: 14, textAlign: "center" },
});
