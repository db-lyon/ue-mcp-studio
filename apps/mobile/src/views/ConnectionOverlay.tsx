/**
 * The connection to ue-mcp as the phone shows it (apps/client-web
 * views/ConnectionOverlay.tsx): the shared state machine (client-core) fed by
 * the project's stream, any answer from ue-mcp, and the app coming back to
 * the foreground. A phone is always a paired client: it cannot start ue-mcp,
 * so past the wait it says ue-mcp is offline and keeps reconnecting. Until
 * then a phone, often on a mobile network, shows only the small line: while
 * reconnecting, and for a restart's first REMOTE_RECONNECT_MS.
 */
import { useEffect, useReducer, useRef } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { CONN_QUIET_MS, REMOTE_OFFLINE, REMOTE_RECONNECT_MS, connected, elapsed, headline, step, waking, type Conn, type ConnEvent } from "@ue-mcp-studio/client-core";
import { Button, edgePadding, font, Row, Spacer, Spinner, T, useInsets, useStyles, type Theme } from "../ui";
import { useProjectNav } from "../nav";
import type { DaemonEvent } from "../state";

export interface Connection {
  conn: Conn;
  now: number;
  log: string;
  /** A paired client, through the relay: it cannot start ue-mcp and only waits for it. */
  remote: boolean;
  retry(): void;
}

/** A phone has no host to start ue-mcp with. */
const noLaunch = async (): Promise<ConnEvent> => ({ type: "started", ok: false, at: Date.now() });

export function useConnection(streaming: boolean, events: DaemonEvent[], updating: boolean, launcher: () => Promise<ConnEvent> = noLaunch, remote = true): Connection {
  const { project } = useProjectNav();
  const conn = useRef<Conn>(connected());
  const now = useRef(Date.now());
  const [, render] = useReducer((n: number) => n + 1, 0);

  const send = (e: ConnEvent): void => {
    const r = step(conn.current, e, false, { remote });
    conn.current = r.conn;
    now.current = e.at;
    render();
    if (r.start) void launcher().then(send);
  };

  // Out of view does not count as ue-mcp being away, and coming back reconnects quietly first.
  useEffect(() => {
    if (!remote) return;
    const sub = AppState.addEventListener("change", (state) => send({ type: "visibility", visible: state === "active", at: Date.now() }));
    return () => sub.remove();
  }, [remote]);
  // A stream still making its first attempt is not down: only one that failed or dropped is.
  const connecting = !streaming && project.live === "connecting";
  useEffect(() => {
    if (!connecting) send({ type: "stream", up: streaming, at: Date.now() });
  }, [streaming, connecting]);
  // Any answer from ue-mcp while the stream is down: it is up, so no panel saying it is away.
  useEffect(
    () =>
      project.onAlive?.((at) => {
        if (conn.current.phase !== "connected") send({ type: "alive", at });
      }),
    [project],
  );

  const last = events[events.length - 1];
  useEffect(() => {
    if (last?.type === "daemon.stopping") send({ type: "stopping", reason: String(last.data.reason ?? ""), updating, at: Date.now() });
  }, [last?.id]);

  const phase = conn.current.phase;
  useEffect(() => {
    if (phase === "connected") return;
    const t = setInterval(() => send({ type: "tick", at: Date.now() }), 1000);
    return () => clearInterval(t);
  }, [phase]);

  return {
    conn: conn.current,
    now: now.current,
    log: "",
    remote,
    retry: () => {
      project.reconnect?.();
      send({ type: "retry", at: Date.now() });
    },
  };
}

/** What the app shows while ue-mcp is away, from a short gap to the point it is offline. */
export function ConnectionOverlay({ c }: { c: Connection }) {
  const s = useStyles(styles);
  const insets = useInsets();
  const { conn, now, remote } = c;
  if (conn.phase === "connected") return null;
  const down = conn.downSince === null ? "" : elapsed(now - conn.downSince);
  // Reconnecting, or a restart still within the wait: the small line over the page, which stays usable.
  const quiet = remote ? conn.phase === "reconnecting" || (conn.phase === "restarting" && conn.downSince !== null && now - conn.downSince < REMOTE_RECONNECT_MS) : waking(conn, now);
  if (quiet) {
    return (
      <View testID="connection-line" style={[s.line, { top: 8 + insets.top, right: 10 + insets.right }]} accessibilityRole="text" accessibilityLiveRegion="polite" pointerEvents="none">
        <Spinner />
        <T style={s.lineText} numberOfLines={1}>
          {conn.phase === "restarting" ? conn.why : "Reconnecting to ue-mcp"}
        </T>
      </View>
    );
  }
  if (conn.phase === "reconnecting" && conn.downSince !== null && now - conn.downSince < CONN_QUIET_MS) return null;
  const offline = remote && (conn.phase === "lost" || conn.phase === "needsYou");
  const needs = conn.phase === "needsYou";
  let body: string;
  switch (conn.phase) {
    case "reconnecting":
      body = `No answer for ${down}. Studio comes back on its own when ue-mcp answers again.`;
      break;
    case "restarting":
      body = `Waiting for it to come back, ${down} so far. Studio loads it as soon as it is up.`;
      break;
    case "lost":
      // The app cannot start ue-mcp (step's canStart is false), so it never says Studio starts it again.
      body = remote ? `${conn.why}, ${down} ago.` : `${conn.why}.`;
      break;
    case "starting":
      body = `${conn.why}, ${down} ago.${conn.failure ? ` ${conn.failure}` : ""} Studio loads it as soon as it is up.`;
      break;
    default:
      body = conn.why ? `${conn.why}, ${down} ago.` : "";
  }
  const head = headline(conn, now, remote);
  return (
    <View testID="connection-overlay" style={[s.overlay, edgePadding(insets, 8)]} accessibilityViewIsModal accessibilityLabel={head}>
      <View style={[s.card, s.shadow]}>
        <View style={s.head}>
          {!needs || remote ? <Spinner /> : null}
          <T style={s.headText}>{head}</T>
        </View>
        {body || offline ? <T style={s.body}>{offline ? `${body} ${REMOTE_OFFLINE}`.trim() : body}</T> : null}
        {needs || offline ? (
          <Row style={s.row}>
            <Spacer />
            <Button title="Retry" variant="primary" onPress={c.retry} />
          </Row>
        ) : null}
      </View>
    </View>
  );
}

const styles = (t: Theme) => ({
  // .conn-line at phone width: the bar's empty right end, over the page, which stays usable.
  line: {
    position: "absolute" as const,
    top: 8,
    right: 10,
    zIndex: 60,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    maxWidth: "92%" as const,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: t.c.line,
    borderRadius: 999,
    backgroundColor: t.c.panel,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  lineText: { ...font(t, "sans", 500, 13, 1.2), color: t.c.text },
  // .overlay with its narrow padding, and .overlay-card.
  overlay: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 60, alignItems: "center" as const, justifyContent: "center" as const, padding: 8, backgroundColor: "rgba(0, 0, 0, 0.55)" },
  card: { width: "100%" as const, maxWidth: 460, gap: 12, padding: 16, borderWidth: 1, borderColor: t.c.line, borderRadius: 10, backgroundColor: t.c.panel },
  shadow: { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 25, shadowOffset: { width: 0, height: 18 }, elevation: 12 },
  head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
  headText: { ...font(t, "sans", 600, 15, 1.2), color: t.c.text, flexShrink: 1 },
  // p.muted.small: 12px with the body's line height, and its 1em margins.
  body: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.muted, marginVertical: 12 },
  row: { marginVertical: 6 },
});
