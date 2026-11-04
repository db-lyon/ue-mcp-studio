/**
 * The panel's connection to ue-mcp, as one state machine: connected,
 * reconnecting, restarting, lost, starting it again, and needs you. Pure:
 * each client's ConnectionOverlay feeds it the stream, the daemon's stopping
 * reason, a clock, and the results of starting ue-mcp. Studio's window
 * (apps/window/src/connection.h) runs the same policy while no page from
 * ue-mcp is loaded.
 */

export type Phase = "connected" | "reconnecting" | "restarting" | "lost" | "starting" | "needsYou";

export interface Conn {
  phase: Phase;
  /** When the stream went down, for the elapsed time; null while connected. */
  downSince: number | null;
  /** Why, in plain words: the stopping reason, or what was seen. */
  why: string;
  /** Starting: the attempt running or next, 1 to MAX_ATTEMPTS. */
  attempt: number;
  /** Lost and starting: when the next step runs. Restarting and reconnecting: when they give up. */
  deadline: number;
  /** Starting: whether the attempt has been launched. */
  launched: boolean;
  /** Needs you: what failed. */
  failure: string;
  /** Needs you: Node.js is missing, so retrying alone does not help. */
  noNode: boolean;
  /** A paired browser's page out of view: time does not count and nothing escalates until it is back. */
  hidden: boolean;
  /** Back in view and reconnecting: until then only a small line says so, never the panel. */
  wakeUntil: number;
}

export type ConnEvent =
  | { type: "stream"; up: boolean; at: number }
  | { type: "stopping"; reason: string; updating: boolean; at: number }
  | { type: "tick"; at: number }
  | { type: "started"; ok: boolean; noNode?: boolean; error?: string; at: number }
  | { type: "retry"; at: number }
  | { type: "visibility"; visible: boolean; at: number }
  | { type: "alive"; at: number };

/** Stream down this long before the panel says so. A stream through the relay that drops usually resumes within a second or two, unseen. */
export const CONN_QUIET_MS = 4000;
/** Stream down with no reason this long: ue-mcp is lost. */
export const RECONNECT_MS = 10_000;
/** A restart this long without a successor: ue-mcp is lost. */
export const RESTART_MS = 60_000;
/** The same while an update restarts it. */
export const UPDATE_RESTART_MS = 180_000;
/** Lost, shown this long before Studio starts ue-mcp itself. */
export const LOST_PAUSE_MS = 3000;
/** One start attempt waits this long for ue-mcp to answer. */
export const ATTEMPT_MS = 45_000;
/** The wait before attempts 2 and 3. */
export const BACKOFF_MS = [5000, 15_000];
export const MAX_ATTEMPTS = 3;
/** Back in view after being hidden: this long of a quiet line while the stream reconnects, before any panel. */
export const WAKE_GRACE_MS = 8000;
/**
 * A paired browser goes through the relay and often a phone network: a stream
 * that drops there is usually back within seconds. It shows the panel only
 * after this long with no answer at all from ue-mcp, and says ue-mcp is
 * offline only after REMOTE_RECONNECT_MS.
 */
export const REMOTE_QUIET_MS = 12_000;
export const REMOTE_RECONNECT_MS = 30_000;
/** Any answer from ue-mcp while the stream reconnects: a quiet line for this long, and the wait starts again. */
export const ALIVE_GRACE_MS = 15_000;

export interface StepOptions {
  /** A paired browser: the longer waits above. */
  remote?: boolean;
}

export const connected = (hidden = false): Conn => ({ phase: "connected", downSince: null, why: "", attempt: 0, deadline: 0, launched: false, failure: "", noNode: false, hidden, wakeUntil: 0 });

/** What a daemon.stopping reason means: whether another daemon follows, and the words for it. */
export function stoppingWhy(reason: string, updating: boolean): { successor: boolean; why: string } {
  if (/handed off/i.test(reason)) return { successor: true, why: "ue-mcp is restarting on a newer version" };
  if (updating) return { successor: true, why: "ue-mcp is restarting for an update" };
  if (/shutdown requested/i.test(reason)) return { successor: true, why: "ue-mcp is restarting" };
  if (/^idle/i.test(reason)) return { successor: false, why: `ue-mcp stopped after being ${reason}` };
  if (/^closed$/i.test(reason)) return { successor: false, why: "ue-mcp was closed" };
  return { successor: false, why: reason ? `ue-mcp stopped: ${reason}` : "ue-mcp stopped" };
}

const lost = (s: Conn, why: string, at: number): Conn => ({ ...s, phase: "lost", why, deadline: at + LOST_PAUSE_MS, attempt: 0, launched: false });

const needsYou = (s: Conn, failure: string, noNode = false): Conn => ({ ...s, phase: "needsYou", failure, noNode, launched: false, deadline: 0 });

const attempt = (s: Conn, n: number, at: number): Conn => ({ ...s, phase: "starting", attempt: n, launched: false, deadline: at, failure: "", noNode: false });

/**
 * One step. `start` says to launch a start attempt now; the caller reports
 * how it went with a "started" event.
 */
export function step(s: Conn, e: ConnEvent, canStart: boolean, opts: StepOptions = {}): { conn: Conn; start: boolean } {
  const same = { conn: s, start: false };
  const reconnectMs = opts.remote ? REMOTE_RECONNECT_MS : RECONNECT_MS;
  switch (e.type) {
    case "stream":
      if (e.up) return { conn: connected(s.hidden), start: false };
      if (s.phase !== "connected") return same;
      return { conn: { ...s, phase: "reconnecting", downSince: e.at, why: "", deadline: e.at + reconnectMs }, start: false };
    case "alive": {
      // ue-mcp answered: it is up and only the stream is reconnecting. Keep to the quiet line and start the wait again.
      const quietable = s.phase === "reconnecting" || (opts.remote === true && (s.phase === "lost" || s.phase === "needsYou"));
      if (!quietable) return same;
      return { conn: { ...s, phase: "reconnecting", why: "", failure: "", noNode: false, attempt: 0, launched: false, wakeUntil: e.at + ALIVE_GRACE_MS, deadline: e.at + ALIVE_GRACE_MS + reconnectMs }, start: false };
    }
    case "stopping": {
      const w = stoppingWhy(e.reason, e.updating);
      const down = s.downSince ?? e.at;
      if (w.successor) return { conn: { ...s, phase: "restarting", downSince: down, why: w.why, deadline: e.at + (e.updating ? UPDATE_RESTART_MS : RESTART_MS) }, start: false };
      return { conn: lost({ ...s, downSince: down }, w.why, e.at), start: false };
    }
    case "visibility": {
      if (!e.visible) return { conn: { ...s, hidden: true }, start: false };
      const back = { ...s, hidden: false };
      if (!s.hidden || s.phase === "connected") return { conn: back, start: false };
      // Away a while and not connected: what was seen while hidden is stale. Reconnect quietly, counting from now.
      return {
        conn: { ...back, phase: "reconnecting", downSince: e.at, why: "", attempt: 0, launched: false, failure: "", noNode: false, wakeUntil: e.at + WAKE_GRACE_MS, deadline: e.at + WAKE_GRACE_MS + reconnectMs },
        start: false,
      };
    }
    case "retry":
      if (s.phase === "connected") return same;
      if (!canStart) return { conn: needsYou(s, cannotStart), start: false };
      return { conn: { ...attempt(s, 1, e.at), launched: true, deadline: e.at + ATTEMPT_MS }, start: true };
    case "started":
      if (s.phase !== "starting" || !s.launched) return same;
      if (e.noNode) return { conn: needsYou(s, "Node.js was not found. ue-mcp runs on Node.js; install it, then retry.", true), start: false };
      if (e.ok) return same;
      return { conn: next(s, e.at, `The start command did not run${e.error ? `: ${e.error}` : "."}`), start: false };
    case "tick": {
      if (s.hidden || s.phase === "connected" || s.phase === "needsYou" || e.at < s.deadline) return same;
      if (s.phase === "reconnecting") return { conn: lost(s, "ue-mcp stopped answering without saying why", e.at), start: false };
      if (s.phase === "restarting") return { conn: lost(s, `${s.why.replace(/^ue-mcp is restarting/, "ue-mcp was restarting")} and did not come back`, e.at), start: false };
      if (s.phase === "lost") {
        if (!canStart) return { conn: needsYou(s, cannotStart), start: false };
        return { conn: { ...attempt(s, 1, e.at), launched: true, deadline: e.at + ATTEMPT_MS }, start: true };
      }
      // Starting: a backoff wait ended, or an attempt ran out of time.
      if (!s.launched) return { conn: { ...s, launched: true, deadline: e.at + ATTEMPT_MS }, start: true };
      return { conn: next(s, e.at, `ue-mcp did not answer within ${ATTEMPT_MS / 1000} seconds of starting.`), start: false };
    }
  }
}

const cannotStart = "Studio cannot start ue-mcp from here. Run npx ue-mcp daemon start <your .uproject> in the project folder, or open Studio from the editor.";

/** The attempt after a failed one, or needs you after the last. */
function next(s: Conn, at: number, failure: string): Conn {
  if (s.attempt >= MAX_ATTEMPTS) return needsYou(s, `ue-mcp did not start after ${MAX_ATTEMPTS} attempts. ${failure}`);
  return { ...attempt(s, s.attempt + 1, at + BACKOFF_MS[Math.min(s.attempt - 1, BACKOFF_MS.length - 1)]), failure };
}

/**
 * Whether the page runs in a paired browser, through the relay: no host
 * binding, and not served from this computer. Such a page cannot start
 * ue-mcp, and its owner cannot run a command on the computer from there.
 */
export function isRemotePage(hasHost: boolean, hostname: string): boolean {
  if (hasHost) return false;
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname.toLowerCase());
}

/** Why a paired browser has no update controls: updates install software on the computer, which only Studio there may do. */
export const REMOTE_UPDATES = "Updates run from Studio on the computer.";

/** What a paired browser shows when ue-mcp on the computer stays away. */
export const REMOTE_OFFLINE = "It may be restarting, or the computer may be asleep or offline. This page reconnects by itself as soon as ue-mcp answers again; there is nothing to run here.";

/** "8s", "1m 05s". */
export function elapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
}

/** Whether the page has just come back into view and is reconnecting: a quiet line, not the panel. */
export function waking(s: Conn, now: number): boolean {
  return s.phase === "reconnecting" && now < s.wakeUntil;
}

/** The head line for a phase. */
export function headline(s: Conn, now: number, remote = false): string {
  if (remote && (s.phase === "lost" || s.phase === "needsYou")) return "ue-mcp on your computer is offline";
  switch (s.phase) {
    case "connected":
      return "Connected to ue-mcp";
    case "reconnecting":
      return "Reconnecting to ue-mcp";
    case "restarting":
      return s.why;
    case "lost":
      return "Lost connection to ue-mcp";
    case "starting":
      return !s.launched && s.deadline > now
        ? `Starting ue-mcp again in ${elapsed(s.deadline - now + 999)} (attempt ${s.attempt} of ${MAX_ATTEMPTS})`
        : `Starting ue-mcp (attempt ${s.attempt} of ${MAX_ATTEMPTS})`;
    case "needsYou":
      return "ue-mcp is not running";
  }
}

/** Whether an HTTP status came from ue-mcp rather than from the relay saying the computer is away. */
export function fromUeMcp(status: number): boolean {
  return status > 0 && status !== 502 && status !== 503 && status !== 504;
}
