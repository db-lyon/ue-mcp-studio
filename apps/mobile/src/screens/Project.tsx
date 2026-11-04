import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { requestJson, studioApi, type PanelLocation, type Transport } from "@ue-mcp-studio/client-core";
import { useLockView, useProject, type Project } from "../connection";
import { NotPairedError, RelayError, type Device } from "../relay";
import { PinPad } from "../PinPad";
import { Button, Dot, Header, s, tap } from "../legacy-ui";
import { SessionScreen } from "./Session";
import { ReviewItemScreen, ReviewScreen } from "./Review";
import { CheckpointsScreen } from "./Checkpoints";
import { ChangeScreen, ChangesScreen } from "./Changes";
import { ProjectContext, type ProjectNav, type Route } from "../nav";
import { colors } from "../theme";

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  archived: boolean;
  awaiting: number;
  waitingCause?: string | null;
  agents?: { total: number; running: number };
}

const STATUS_LABEL: Record<string, string> = { idle: "Idle", running: "Working", waiting: "Waiting", error: "Error", stopped: "Stopped" };

export function ProjectScreen({ device, onBack, onUnpaired, transport, initial }: { device: Device; onBack: () => void; onUnpaired: (message: string) => void; transport?: Transport; initial?: PanelLocation }) {
  const project = useProject(device, transport);
  const [stack, setStack] = useState<Route[]>(() => (initial?.tab === "Chat" && initial.session ? [{ name: "session", id: initial.session }] : []));
  const api = useMemo(() => studioApi(project.transport), [project.transport]);
  const nav = useMemo<ProjectNav>(() => ({ project, api, push: (r) => setStack((s) => [...s, r]), pop: () => setStack((s) => s.slice(0, -1)) }), [project, api]);
  const top = stack[stack.length - 1];

  // Android back pops the project's own stack first; registered after the app's handler, so it runs first.
  useEffect(() => {
    if (!top) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => (nav.pop(), true));
    return () => sub.remove();
  }, [top, nav]);

  return (
    <ProjectContext.Provider value={nav}>
      <View style={{ flex: 1 }} onTouchStart={() => project.lock.touched()}>
        {!top ? <Sessions project={project} onBack={onBack} onOpen={(id) => nav.push({ name: "session", id })} onChanges={() => nav.push({ name: "changes" })} onUnpaired={onUnpaired} /> : null}
        {top?.name === "session" ? <SessionScreen key={top.id} id={top.id} /> : null}
        {top?.name === "review" ? <ReviewScreen sessionId={top.sessionId} review={top.review} /> : null}
        {top?.name === "reviewItem" ? <ReviewItemScreen sessionId={top.sessionId} reviewId={top.reviewId} path={top.path} /> : null}
        {top?.name === "checkpoints" ? <CheckpointsScreen sessionId={top.sessionId} /> : null}
        {top?.name === "changes" ? <ChangesScreen /> : null}
        {top?.name === "change" ? <ChangeScreen path={top.path} /> : null}
        <Lock project={project} onUnpaired={onUnpaired} />
      </View>
    </ProjectContext.Provider>
  );
}

function Lock({ project, onUnpaired }: { project: Project; onUnpaired: (message: string) => void }) {
  const lockView = useLockView(project.lock);
  return (
    <>
      {lockView.screen || lockView.prompt || lockView.removed ? <PinPad lock={project.lock} view={lockView} onRemoved={() => onUnpaired("This phone was removed after too many wrong PINs. Pair it again.")} /> : null}
    </>
  );
}

function Sessions({ project, onBack, onOpen, onChanges, onUnpaired }: { project: Project; onBack: () => void; onOpen: (id: string) => void; onChanges: () => void; onUnpaired: (message: string) => void }) {
  const { device, transport, live, dropCause, onEvent, lock } = project;
  const lockView = useLockView(lock);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const h = await requestJson<{ version?: string }>(transport, "GET", "/v1/health");
      setVersion(h.version ?? null);
      const r = await requestJson<{ sessions: SessionRow[] }>(transport, "GET", "/v1/ext/studio/sessions");
      setSessions(r.sessions.filter((x) => !x.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setError(null);
    } catch (e) {
      if (e instanceof NotPairedError) return onUnpaired("The relay no longer knows this phone. Pair it again.");
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof RelayError && e.status === 503 ? "Your computer is offline. Studio reconnects when it is back." : String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [transport, onUnpaired]);

  useEffect(() => void load(), [load]);
  // Live: the list follows the daemon's session events, and reloads whenever the stream comes back.
  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== "studio.session.changed" && e.type !== "gap") return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 300);
      }),
    [onEvent, load],
  );
  useEffect(() => {
    if (live === "live") void load();
  }, [live, load]);

  const create = async () => {
    setCreating(true);
    try {
      const d = await requestJson<{ id: string }>(transport, "POST", "/v1/ext/studio/sessions");
      onOpen(d.id);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setCreating(false);
    }
  };

  const liveText = live === "live" ? `Live${version ? `. ue-mcp ${version}` : ""}` : live === "connecting" ? "Connecting" : `Reconnecting${dropCause ? ` (${dropCause})` : ""}`;

  return (
    <View style={s.page}>
      <Header
        title={device.name}
        back="Projects"
        onBack={onBack}
        right={
          <View style={{ flexDirection: "row", gap: 18 }}>
            <Pressable accessibilityRole="button" onPress={onChanges} hitSlop={8} style={tap}>
              <Text style={s.link}>Changes</Text>
            </Pressable>
            {lockView.state?.whole ? (
              <Pressable accessibilityRole="button" onPress={() => void lock.lockNow()} hitSlop={8} style={tap}>
                <Text style={s.link}>Lock</Text>
              </Pressable>
            ) : null}
          </View>
        }
      />
      <View style={[s.row, { paddingTop: 0 }]}>
        <Dot state={live === "live" ? "on" : live === "connecting" ? "busy" : "error"} />
        <Text style={[s.sub, { flex: 1 }]} numberOfLines={2}>
          {liveText}
        </Text>
      </View>
      {error ? <Text style={[s.error, { marginTop: 8 }]}>{error}</Text> : null}
      <Text style={s.section}>Sessions</Text>
      <FlatList
        data={sessions ?? []}
        keyExtractor={(x) => x.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.panel} />}
        ListEmptyComponent={sessions ? <Text style={s.sub}>No sessions yet.</Text> : undefined}
        renderItem={({ item }) => (
          <Pressable style={s.row} accessibilityRole="button" onPress={() => onOpen(item.id)}>
            <Dot state={item.status === "running" ? "busy" : item.awaiting || item.status === "waiting" ? "busy" : item.status === "error" ? "error" : "off"} />
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>
                {item.title || "New session"}
              </Text>
              <Text style={s.sub} numberOfLines={1}>
                {STATUS_LABEL[item.status] ?? item.status}
                {item.awaiting ? `. ${item.awaiting} waiting for approval` : ""}. {new Date(item.updatedAt).toLocaleString()}
              </Text>
            </View>
          </Pressable>
        )}
      />
      <Button title="New session" primary disabled={creating || live !== "live"} onPress={() => void create()} />
    </View>
  );
}
