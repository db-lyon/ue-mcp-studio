import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DaemonEvent } from "ue-mcp/daemon";
import { reconnectEvents } from "../api";
import { native } from "../native";
import { QUIET_MS, REMOTE_OFFLINE, connected, elapsed, headline, isRemotePage, step, waking, type Conn, type ConnEvent } from "../connection";

interface HostStatus {
  node?: boolean;
  log?: string;
}

async function hostStatus(): Promise<HostStatus> {
  const text = await native().getstatus?.().catch(() => "");
  try {
    return text ? (JSON.parse(text) as HostStatus) : {};
  } catch {
    return {};
  }
}

/** One start attempt through the host: the editor or Studio's window. */
async function launch(): Promise<ConnEvent> {
  const status = await hostStatus();
  if (status.node === false) return { type: "started", ok: false, noNode: true, at: Date.now() };
  const ok = (await native().startdaemon?.().catch(() => false)) ?? false;
  return { type: "started", ok, at: Date.now() };
}

export interface Connection {
  conn: Conn;
  now: number;
  log: string;
  /** A paired browser, through the relay: it cannot start ue-mcp and only waits for it. */
  remote: boolean;
  retry(): void;
}

/**
 * The connection state machine, driven by the event stream. The page stays in
 * charge while ue-mcp is away: it tells Studio's window so, and the window
 * follows ue-mcp to its next address when one comes up.
 */
export function useConnection(
  streaming: boolean,
  events: DaemonEvent[],
  updating: boolean,
  launcher: () => Promise<ConnEvent> = launch,
  // The visual QA harness sets __studioRemotePage to show a paired browser's page from this computer.
  remote: boolean = (window as unknown as { __studioRemotePage?: boolean }).__studioRemotePage ?? isRemotePage(!!window.ue, window.location.hostname),
): Connection {
  const conn = useRef<Conn>(connected());
  const now = useRef(Date.now());
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [log, setLog] = useState("");
  const canStart = !!native().startdaemon;

  const send = (e: ConnEvent): void => {
    const r = step(conn.current, e, canStart);
    const changed = r.conn.phase !== conn.current.phase || r.conn.attempt !== conn.current.attempt;
    conn.current = r.conn;
    if (changed) report(r.conn);
    now.current = e.at;
    render();
    if (r.start) void launcher().then(send);
  };

  useEffect(() => report(conn.current), []);

  // A paired browser: time out of view does not count as ue-mcp being away, and coming back reconnects quietly first.
  useEffect(() => {
    if (!remote) return;
    const seen = (): void => send({ type: "visibility", visible: document.visibilityState !== "hidden", at: Date.now() });
    seen();
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("pageshow", seen);
    document.addEventListener("resume", seen);
    return () => {
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("pageshow", seen);
      document.removeEventListener("resume", seen);
    };
  }, [remote]);
  useEffect(() => send({ type: "stream", up: streaming, at: Date.now() }), [streaming]);

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

  useEffect(() => {
    if (phase === "needsYou") void hostStatus().then((s) => setLog(s.log ?? ""));
  }, [phase]);

  return {
    conn: conn.current,
    now: now.current,
    log,
    remote,
    retry: () => {
      reconnectEvents();
      send({ type: "retry", at: Date.now() });
    },
  };
}

/** The page's state for Studio's window, which logs it and leaves the page in place. */
function report(c: Conn): void {
  void native().setconnectionstate?.(JSON.stringify({ phase: c.phase, why: c.why, attempt: c.attempt, failure: c.failure })).catch(() => false);
}

/** What the panel shows while ue-mcp is away, from a short gap to the point it needs you. */
export function ConnectionOverlay({ c }: { c: Connection }) {
  const { conn, now, log, remote } = c;
  if (conn.phase === "connected") return null;
  const down = conn.downSince === null ? "" : elapsed(now - conn.downSince);
  if (waking(conn, now)) {
    return createPortal(
      <div className="conn-line" role="status">
        <span className="spinner" aria-hidden />
        Reconnecting to ue-mcp
      </div>,
      document.body,
    );
  }
  if (conn.phase === "reconnecting" && conn.downSince !== null && now - conn.downSince < QUIET_MS) return null;
  // A paired browser cannot start ue-mcp: past the wait it only says so and keeps reconnecting.
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
      body = remote ? `${conn.why}, ${down} ago.` : `${conn.why}. Studio starts it again in a moment.`;
      break;
    case "starting":
      body = `${conn.why}, ${down} ago.${conn.failure ? ` ${conn.failure}` : ""} Studio loads it as soon as it is up.`;
      break;
    default:
      body = conn.why ? `${conn.why}, ${down} ago.` : "";
  }
  return createPortal(
    <div className="overlay" data-phase={conn.phase} role={needs && !remote ? "alertdialog" : "status"} aria-label={headline(conn, now, remote)}>
      <div className="overlay-card">
        <div className="overlay-head">
          {(!needs || remote) && <span className="spinner" aria-hidden />}
          {headline(conn, now, remote)}
        </div>
        {(body || offline) && <p className="muted small">{offline ? `${body} ${REMOTE_OFFLINE}`.trim() : body}</p>}
        {needs && !remote && <div className="banner bad small">{conn.failure}</div>}
        {needs && !remote && log && <p className="dim small">Log: <code>{log}</code></p>}
        {(needs || offline) && (
          <div className="row">
            <span className="spacer" />
            {conn.noNode && native().opennodedownload && <button onClick={() => void native().opennodedownload!()}>Download Node.js</button>}
            {native().openlog && <button onClick={() => void native().openlog!()}>Open log</button>}
            <button className="primary" onClick={c.retry}>Retry</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
