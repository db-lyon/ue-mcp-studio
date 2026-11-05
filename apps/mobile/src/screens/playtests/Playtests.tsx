/**
 * The project's playtests in one place, as the web client's Playtests page:
 * every PIE test script with its newest run as a card, when and where it ran,
 * the filters (Active, Needs you, Failing, All) with their counts, the legend
 * of the step marks, and the notices for an editor that cannot list scripts.
 * Each card works as it does in a session; a script no session has gets one
 * on its first action. Read again when runs change and when the stream is back.
 */
import { lhOf } from "./live";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View, Text } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  PLAYTEST_FILTERS,
  PLAYTEST_RELOAD_MS,
  PLAYTEST_RELOAD_ON,
  defaultPlaytestFilter,
  playtestFilterOf,
  playtestTarget,
  playtestWhen,
  type StreamEvent,
} from "@ue-mcp-studio/client-core";
import { playtestMatches, playtestShown, type PlaytestEntry, type PlaytestFilter, type PlaytestIndexAnswer, type QaRun } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../nav";
import { Banner, NavBarBacking, T, bannerText, font, useSheetInsets, useStyles, useTheme, type Theme } from "../../ui";
import { QaContext, RevealContext, useDaemonEvents, type Measurable, type QaLive, type RevealBlock } from "./live";
import { QaCard, useSavedScript, type QaCardActions } from "./QaCard";
import { PathLegend } from "./StepPath";
import { SmallButton } from "./parts";
import { AssetLinksContext, useAssetLinks } from "./StepText";

export const FILTER_KEY = "studio.playtests.filter";

/** The project's playtests, read again as runs change. */
/** What a page of cards reads from the daemon: its recent events and whether its stream is up. */
export type Daemonish = { events: StreamEvent[]; streaming: boolean };

export function usePlaytestIndex({ events, streaming }: Daemonish): { index: PlaytestIndexAnswer | null; error: string | null; reload: (fresh?: boolean) => void } {
  const { api } = useProjectNav();
  const [index, setIndex] = useState<PlaytestIndexAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = (fresh = false) =>
    void api.qaPlaytests(fresh).then(
      (r) => {
        setIndex(r);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    if (streaming) reload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);
  const last = [...events].reverse().find((e) => PLAYTEST_RELOAD_ON.has(e.type));
  useEffect(() => {
    if (!last) return;
    const timer = setTimeout(() => reload(), PLAYTEST_RELOAD_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id]);
  return { index, error, reload };
}

/** The page on its own, reading the project's events and index itself. */
export function PlaytestsScreen({ onOpenSession, onChat }: { onOpenSession: (sessionId: string, runId: string) => void; onChat?: () => void }) {
  const { project } = useProjectNav();
  const daemon = useDaemonEvents(project);
  const index = usePlaytestIndex(daemon);
  return <PlaytestsView daemon={daemon} index={index} onOpenSession={onOpenSession} onChat={onChat} />;
}

/** The page over the index the app keeps, which also counts what needs the user on the tab (web: PlaytestsView). */
export function PlaytestsView({ daemon, index: source, onOpenSession, onChat }: { daemon: Daemonish; index: ReturnType<typeof usePlaytestIndex>; onOpenSession: (sessionId: string, runId: string) => void; onChat?: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const insets = useSheetInsets();
  const { events, streaming } = daemon;
  const { index, error, reload } = source;
  const all = useMemo(() => (index?.playtests ?? []).filter((e) => !e.deleted), [index]);
  const counts = useMemo(() => Object.fromEntries(PLAYTEST_FILTERS.map((f) => [f.id, all.filter((e) => playtestMatches(e, f.id)).length])) as Record<PlaytestFilter, number>, [all]);
  const [picked, setPicked] = useState<PlaytestFilter | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync(FILTER_KEY).then((v) => setPicked((cur) => cur ?? playtestFilterOf(v)), () => undefined);
  }, []);
  const filter = picked ?? defaultPlaytestFilter(counts);
  const pick = (f: PlaytestFilter) => {
    setPicked(f);
    void SecureStore.setItemAsync(FILTER_KEY, f).catch(() => undefined);
  };
  const rows = all.filter((e) => playtestMatches(e, filter));
  const live: QaLive = useMemo(() => ({ events, streaming, forms: [], sessionId: null }), [events, streaming]);
  const assetLinks = useAssetLinks(null);
  const [pulling, setPulling] = useState(false);
  const scroller = useRef<{ scrollTo(o: { y: number; animated: boolean }): void } | null>(null);
  const content = useRef<Measurable | null>(null);
  // An opened card comes to the top of the page, as the web client scrolls it into view.
  const reveal = useMemo(() => (node: Measurable | null, block: RevealBlock = "start") => {
    if (!node || !content.current || block !== "start") return;
    // scrollIntoView lands on the nearest whole pixel to a card at a fractional offset.
    const go = (y: number) => scroller.current?.scrollTo({ y: Math.round(y + 10), animated: true });
    // The web build's measureLayout adds up offsetTops, each rounded; the boxes themselves keep the fraction.
    const rect = (n: unknown) => (n as { getBoundingClientRect?: () => { top: number } }).getBoundingClientRect?.();
    const [a, b] = Platform.OS === "web" ? [rect(node), rect(content.current)] : [];
    if (a && b) go(a.top - b.top);
    else node.measureLayout(content.current, (_x, y) => go(y), () => undefined);
  }, []);
  const pulled = useRef(false);
  useEffect(() => {
    if (pulled.current && index) setPulling(false);
  }, [index]);

  return (
    <>
    <ScrollView
      ref={scroller as never}
      style={s.scroll}
      // Its end scrolls clear of the navigation bar, or of the keyboard while a field has it up.
      contentContainerStyle={[s.page, { paddingBottom: 18 + insets.bottom }]}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => ((pulled.current = true), setPulling(true), reload(true))} tintColor={t.c.accent} colors={[t.c.accent]} progressBackgroundColor={t.c.panel} />}
      testID="playtests-page"
    >
      <View ref={content as never} style={s.content}>
      <View style={s.head}>
        <T style={s.title} accessibilityRole="header">Playtests</T>
        <T style={s.count} numberOfLines={1}>
          {index ? (index.listed ? `${all.length} in this project` : `${all.length} last known`) : ""}
          {index?.listed !== false && counts["needs-you"] > 0 ? <Text style={{ color: t.c.warn }}> · {counts["needs-you"]} need{counts["needs-you"] === 1 ? "s" : ""} you</Text> : null}
        </T>
        <View style={{ flex: 1 }} />
        <SmallButton title="Refresh" label="Refresh: list the project's scripts again" onPress={() => reload(true)} style={s.refresh} />
      </View>
      {all.length > 0 ? (
        <View style={s.filters} accessibilityLabel="Show">
          {PLAYTEST_FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <Pressable key={f.id} accessibilityRole="button" accessibilityState={{ selected: on }} aria-pressed={on} accessibilityLabel={`${f.label} ${counts[f.id]}`} onPress={() => pick(f.id)} style={[s.chip, on && s.chipOn]}>
                <T style={[s.chipText, on && { color: t.c.text }]}>
                  {f.label}{" "}
                  <Text style={[s.chipCount, { color: on ? t.c.text : t.c.muted }, Platform.OS === "web" ? ({ marginLeft: 4 } as object) : null]}>{Platform.OS === "web" ? "" : " "}{counts[f.id]}</Text>
                </T>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {rows.length > 0 ? <PathLegend runs={rows.map(playtestShown).filter((r): r is QaRun => !!r)} /> : null}
      {error ? (
        <Banner kind="bad" role="alert" >
          <T style={[s.small, { color: bannerText(t, "bad") }]}>{error}</T>
        </Banner>
      ) : null}
      {index && !index.listed ? (
        <Banner kind="warn" >
          <T style={[s.small, { color: bannerText(t, "warn") }]}>The editor is not connected: scripts that have never run are missing, and runs, verdicts and subagents are unavailable until it is back.</T>
        </Banner>
      ) : null}
      {!index && !error ? <T style={[s.small, { color: t.c.dim, marginVertical: 13.5 }]}>Loading playtests</T> : null}
      {index && rows.length === 0 ? (
        all.length === 0 ? (
          <View style={s.empty}>
            <T style={{ ...font(t, "sans", 700, t.base.size), lineHeight: t.base.lineHeight, color: t.c.text }}>No playtests yet</T>
            <T style={{ color: t.c.muted }}>
              Ask the agent for one in a session, or type <Text style={{ ...font(t, "mono", 400, t.base.size * 0.92), color: t.c.text }}>/playtest</Text> in the message box.
            </T>
            {onChat ? <SmallButton title="Go to Chat" primary onPress={onChat} /> : null}
          </View>
        ) : (
          <T style={{ color: t.c.muted, marginVertical: 24 }}>{PLAYTEST_FILTERS.find((f) => f.id === filter)!.empty}</T>
        )
      ) : null}
      <QaContext.Provider value={live}>
        <AssetLinksContext.Provider value={assetLinks}>
          <RevealContext.Provider value={reveal}>
          <View style={s.list}>
            {rows.map((e) => (
              <PlaytestRow key={e.script} entry={e} offline={index?.listed === false} onOpenSession={onOpenSession} onChanged={() => reload(true)} />
            ))}
          </View>
          </RevealContext.Provider>
        </AssetLinksContext.Provider>
      </QaContext.Provider>
      </View>
    </ScrollView>
    <NavBarBacking />
    </>
  );
}

/** Where and when the shown run ran. The session's name is the way to its card there. */
function Meta({ entry, open }: { entry: PlaytestEntry; open?: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const title = entry.session?.title || "Untitled";
  return (
    <View style={s.metaRow}>
      <T style={[s.small, { color: t.c.dim }]}>
        {playtestWhen(entry)}
        {entry.session ? " in " : entry.last ? " outside Studio" : ""}
      </T>
      {entry.session ? (
        open ? (
          <Pressable accessibilityRole="link" accessibilityLabel={`Open the card in ${title}`} onPress={open} style={s.sessionLink}>
            <T style={[s.small, s.sessionName]} numberOfLines={1}>{title}</T>
            <T style={[s.small, { color: t.c.accent }]}>{"↗"}</T>
          </Pressable>
        ) : (
          <T style={[s.small, s.sessionName, { color: t.c.muted, textDecorationLine: "none" }]} numberOfLines={1}>{title}</T>
        )
      ) : null}
    </View>
  );
}

export function PlaytestRow({ entry, offline = false, onOpenSession, onChanged }: { entry: PlaytestEntry; offline?: boolean; onOpenSession: (sessionId: string, runId: string) => void; onChanged: () => void }) {
  const { api } = useProjectNav();
  const shown = playtestShown(entry);
  const script = useSavedScript(entry.script, onChanged);
  /** The card in a session, made on the first action that needs one. */
  const card = async (): Promise<QaRun> => entry.card ?? (await api.qaPlaytestCard(entry.script)).run;
  const actions: QaCardActions = {
    start: async (o) => {
      const r = await api.qaRun((await card()).runId, o);
      onChanged();
      return r;
    },
    assign: async () => {
      const r = await api.qaAssign((await card()).runId, null);
      onChanged();
      return r;
    },
    script,
  };
  if (!shown) return null;
  const target = playtestTarget(entry);
  const go = target?.sessionId ? () => onOpenSession(target.sessionId!, target.runId) : undefined;
  return <QaCard run={shown} actions={actions} meta={<Meta entry={entry} open={go} />} slotted offline={offline ? "The editor is not connected" : undefined} testID={`playtest-${entry.name}`} />;
}

const styles = (t: Theme) => ({
  scroll: { flex: 1 },
  page: { paddingTop: 10, paddingHorizontal: 10, paddingBottom: 18 },
  content: { gap: 10 },
  head: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 10 },
  title: { ...font(t, "sans", 600, 20, 1.2), color: t.c.text },
  count: { ...font(t, "sans", 400, 12, lhOf(t)), color: t.c.dim, flexShrink: 1 },
  refresh: { flexShrink: 0 },
  filters: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
  chip: { minHeight: 44, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: t.c.lineStrong, justifyContent: "center" as const },
  chipOn: { backgroundColor: t.c.accentWash, borderColor: t.c.accent },
  chipText: { ...font(t, "sans", 500, 12, 1), color: t.c.muted },
  chipCount: { fontFamily: font(t, "sans", 600, 12).fontFamily },
  small: font(t, "sans", 400, 12, lhOf(t)),
  list: { gap: 8 },
  empty: {
    alignItems: "flex-start" as const,
    gap: 8,
    paddingVertical: 18,
    paddingHorizontal: 20,
    marginVertical: 24,
    backgroundColor: t.c.panel,
    borderWidth: 1,
    borderColor: t.c.line,
    borderRadius: t.radiusLg,
    ...(t.shadow ? { boxShadow: "0 20px 40px -24px rgba(0, 0, 0, 0.6)" } : {}),
  },
  metaRow: { flexDirection: "row" as const, alignItems: "baseline" as const, flexWrap: "wrap" as const, minWidth: 0 },
  sessionLink: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 4, paddingVertical: 13, marginVertical: -13, maxWidth: "100%" as const },
  sessionName: { color: t.c.accent, textDecorationLine: "underline" as const, maxWidth: t.editor ? 108 : 140.5 },
});
