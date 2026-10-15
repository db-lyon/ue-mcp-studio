import { describe, expect, it } from "vitest";
import { ATTEMPT_MS, BACKOFF_MS, LOST_PAUSE_MS, MAX_ATTEMPTS, RECONNECT_MS, RESTART_MS, UPDATE_RESTART_MS, connected, headline, step, stoppingWhy, type Conn, type ConnEvent } from "./connection";

/** Feed events in order; collect when an attempt is launched. */
function run(events: ConnEvent[], canStart = true, from: Conn = connected()): { conn: Conn; starts: number[] } {
  let conn = from;
  const starts: number[] = [];
  for (const e of events) {
    const r = step(conn, e, canStart);
    conn = r.conn;
    if (r.start) starts.push(e.at);
  }
  return { conn, starts };
}

const down = (at: number): ConnEvent => ({ type: "stream", up: false, at });
const up = (at: number): ConnEvent => ({ type: "stream", up: true, at });
const tick = (at: number): ConnEvent => ({ type: "tick", at });
const stopping = (reason: string, at: number, updating = false): ConnEvent => ({ type: "stopping", reason, updating, at });
const started = (ok: boolean, at: number, noNode = false): ConnEvent => ({ type: "started", ok, noNode, at });

describe("the connection to ue-mcp", () => {
  it("a brief gap reconnects, and the stream back is connected again", () => {
    const r = run([down(0), tick(5000)]);
    expect(r.conn.phase).toBe("reconnecting");
    expect(headline(r.conn, 5000)).toBe("Reconnecting to ue-mcp");
    expect(run([up(6000)], true, r.conn).conn.phase).toBe("connected");
  });

  it("a gap with no reason is lost after the reconnect window, then starts ue-mcp itself", () => {
    const r = run([down(0), tick(RECONNECT_MS - 1)]);
    expect(r.conn.phase).toBe("reconnecting");
    const l = run([tick(RECONNECT_MS)], true, r.conn);
    expect(l.conn.phase).toBe("lost");
    expect(l.conn.why).toBe("ue-mcp stopped answering without saying why");
    const s = run([tick(RECONNECT_MS + LOST_PAUSE_MS)], true, l.conn);
    expect(s.conn.phase).toBe("starting");
    expect(s.starts).toEqual([RECONNECT_MS + LOST_PAUSE_MS]);
    expect(headline(s.conn, RECONNECT_MS + LOST_PAUSE_MS)).toBe("Starting ue-mcp (attempt 1 of 3)");
  });

  it("a handoff or update restart waits for its successor and starts nothing", () => {
    const h = run([stopping("handed off to a newer daemon", 0), down(10), tick(RESTART_MS - 1)]);
    expect(h.conn.phase).toBe("restarting");
    expect(headline(h.conn, 1)).toBe("ue-mcp is restarting on a newer version");
    expect(h.starts).toEqual([]);
    const u = run([stopping("shutdown requested", 0, true), down(10), tick(RESTART_MS + 1000)]);
    expect(u.conn.phase).toBe("restarting");
    expect(u.conn.why).toBe("ue-mcp is restarting for an update");
    expect(run([tick(UPDATE_RESTART_MS)], true, u.conn).conn.phase).toBe("lost");
    expect(run([stopping("shutdown requested", 0)]).conn.why).toBe("ue-mcp is restarting");
  });

  it("a restart with no successor is lost, saying what it was waiting for", () => {
    const r = run([stopping("handed off to a newer daemon", 0), down(10), tick(RESTART_MS)]);
    expect(r.conn.phase).toBe("lost");
    expect(r.conn.why).toBe("ue-mcp was restarting on a newer version and did not come back");
  });

  it("an exit with no successor is lost at once, with its reason", () => {
    expect(run([stopping("idle for 30 min", 0)]).conn).toMatchObject({ phase: "lost", why: "ue-mcp stopped after being idle for 30 min" });
    expect(run([stopping("closed", 0)]).conn).toMatchObject({ phase: "lost", why: "ue-mcp was closed" });
    expect(stoppingWhy("out of memory", false)).toEqual({ successor: false, why: "ue-mcp stopped: out of memory" });
  });

  it("retries with backoff, then needs you after the last attempt", () => {
    let t = 0;
    let r = run([stopping("closed", t), tick((t += LOST_PAUSE_MS))]);
    expect(r.starts.length).toBe(1);
    r = run([started(true, t), tick((t += ATTEMPT_MS))], true, r.conn);
    expect(r.conn).toMatchObject({ phase: "starting", attempt: 2, launched: false });
    expect(headline(r.conn, t)).toBe(`Starting ue-mcp again in ${BACKOFF_MS[0] / 1000}s (attempt 2 of 3)`);
    expect(r.conn.failure).toMatch(/did not answer within 45 seconds/);
    r = run([tick(t + BACKOFF_MS[0] - 1)], true, r.conn);
    expect(r.starts).toEqual([]);
    r = run([tick((t += BACKOFF_MS[0]))], true, r.conn);
    expect(r.starts).toEqual([t]);
    // The start command itself fails: on to the next attempt without waiting out the attempt.
    r = run([started(false, t), tick((t += BACKOFF_MS[1]))], true, r.conn);
    expect(r.conn).toMatchObject({ phase: "starting", attempt: MAX_ATTEMPTS, launched: true });
    r = run([started(true, t), tick((t += ATTEMPT_MS))], true, r.conn);
    expect(r.conn.phase).toBe("needsYou");
    expect(r.conn.failure).toMatch(/^ue-mcp did not start after 3 attempts\./);
    expect(r.conn.why).toBe("ue-mcp was closed");
    // Needs you waits for the user.
    expect(run([tick(t + 600_000)], true, r.conn).conn.phase).toBe("needsYou");
    const again = run([{ type: "retry", at: t + 1 }], true, r.conn);
    expect(again.conn).toMatchObject({ phase: "starting", attempt: 1, launched: true });
    expect(again.starts).toEqual([t + 1]);
  });

  it("missing Node.js needs you at once", () => {
    const r = run([stopping("closed", 0), tick(LOST_PAUSE_MS), started(false, LOST_PAUSE_MS, true)]);
    expect(r.conn).toMatchObject({ phase: "needsYou", noNode: true });
    expect(r.conn.failure).toMatch(/Node\.js was not found/);
  });

  it("with no host to start ue-mcp, lost goes straight to needs you", () => {
    const r = run([down(0), tick(RECONNECT_MS), tick(RECONNECT_MS + LOST_PAUSE_MS)], false);
    expect(r.conn.phase).toBe("needsYou");
    expect(r.conn.failure).toMatch(/npx ue-mcp daemon start/);
    expect(r.starts).toEqual([]);
  });

  it("ue-mcp answering again ends any phase", () => {
    const r = run([stopping("closed", 0), tick(LOST_PAUSE_MS), up(LOST_PAUSE_MS + 10)]);
    expect(r.conn).toEqual(connected());
  });

  it("a late start result after the stream came back changes nothing", () => {
    const r = run([stopping("closed", 0), tick(LOST_PAUSE_MS), up(5000), started(false, 6000)]);
    expect(r.conn.phase).toBe("connected");
  });
});
