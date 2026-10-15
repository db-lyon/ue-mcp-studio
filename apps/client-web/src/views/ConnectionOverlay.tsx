import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DaemonEvent } from "ue-mcp/daemon";
import { native } from "../native";
import { QUIET_MS, connected, elapsed, headline, step, type Conn, type ConnEvent } from "../connection";

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
  retry(): void;
}

/**
 * The connection state machine, driven by the event stream. The page stays in
 * charge while ue-mcp is away: it tells Studio's window so, and the window
 * follows ue-mcp to its next address when one comes up.
 */
export function useConnection(streaming: boolean, events: DaemonEvent[], updating: boolean, launcher: () => Promise<ConnEvent> = launch): Connection {
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

  return { conn: conn.current, now: now.current, log, retry: () => send({ type: "retry", at: Date.now() }) };
}

/** The page's state for Studio's window, which logs it and leaves the page in place. */
function report(c: Conn): void {
  void native().setconnectionstate?.(JSON.stringify({ phase: c.phase, why: c.why, attempt: c.attempt, failure: c.failure })).catch(() => false);
}

/** What the panel shows while ue-mcp is away, from a short gap to the point it needs you. */
export function ConnectionOverlay({ c }: { c: Connection }) {
  const { conn, now, log } = c;
  if (conn.phase === "connected") return null;
  const down = conn.downSince === null ? "" : elapsed(now - conn.downSince);
  if (conn.phase === "reconnecting" && conn.downSince !== null && now - conn.downSince < QUIET_MS) return null;
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
      body = `${conn.why}. Studio starts it again in a moment.`;
      break;
    case "starting":
      body = `${conn.why}, ${down} ago.${conn.failure ? ` ${conn.failure}` : ""} Studio loads it as soon as it is up.`;
      break;
    default:
      body = conn.why ? `${conn.why}, ${down} ago.` : "";
  }
  return createPortal(
    <div className="overlay" role={needs ? "alertdialog" : "status"} aria-label={headline(conn, now)}>
      <div className="overlay-card">
        <div className="overlay-head">
          {!needs && <span className="spinner" aria-hidden />}
          {headline(conn, now)}
        </div>
        {body && <p className="muted small">{body}</p>}
        {needs && <div className="banner bad small">{conn.failure}</div>}
        {needs && log && <p className="dim small">Log: <code>{log}</code></p>}
        {needs && (
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
