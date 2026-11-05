/**
 * ue-mcp away and back, as the relay answers while the computer's daemon
 * restarts: the small Reconnecting line first and the offline panel only
 * after REMOTE_RECONNECT_MS, never the relay's own "That project is offline."
 * as an error; and once the project answers again the sessions, the open
 * session and its transcript are read again without a touch. Pull to refresh
 * reads them again too.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HttpError, REMOTE_RECONNECT_MS, type Transport } from "@ue-mcp-studio/client-core";
import type { SessionDetail } from "@ue-mcp-studio/shared";
import { RelayError } from "../src/relay";
import { Chat, NOT_ANSWERING, RETRY_MS } from "../src/views/Chat";
import { store } from "./mocks/secure-store";
import { fakeApi, renderInProject, session } from "./helpers";

const fixture = vi.hoisted(() => ({ transport: null as Transport | null }));
vi.mock("../src/relay", async (original) => {
  const real = await original<typeof import("../src/relay")>();
  // The relay lists the last project online, so the app opens straight into it.
  return { ...real, transportFor: () => fixture.transport!, account: async () => ({ devices: [{ id: "dev1", name: "Lyra", online: true, computerKey: "k1", lastSeen: "2026-11-04T12:00:00Z" }], viewers: [] }) };
});
// react-native-web draws no pull gesture: a button stands in for the pull.
vi.mock("react-native", async (original) => {
  const real = await original<typeof import("react-native")>();
  return {
    ...real,
    RefreshControl: ({ onRefresh, children, style }: { onRefresh: () => void; children?: ReactNode; style?: unknown }) => (
      <real.View style={[{ flex: 1 }, style as never]}>
        <real.Pressable accessibilityLabel="Pull to refresh" onPress={onRefresh} />
        {children}
      </real.View>
    ),
  };
});

const DEVICE = { id: "dev1", name: "Lyra", online: true, computerKey: "k1", lastSeen: "2026-11-04T12:00:00Z" };
const SESSIONS = [{ id: "s1", title: "Door that opens", status: "idle", createdAt: "2026-11-04T12:00:00Z", updatedAt: "2026-11-04T12:05:00Z", archived: false, awaiting: 0, agents: { total: 0, running: 0 } }];
const OFFLINE = "That project is offline.";

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});

/**
 * The relay and the computer behind it: while `online` is off every request
 * is refused as the relay refuses it, and going off ends the open event
 * stream, as a daemon that stops does. A new daemon comes back with a new
 * startedAt, and the transcript has moved on.
 */
function computer() {
  const state = { online: true, daemon: "a", said: "Make the door open", syncs: 0 };
  const streams = new Set<() => void>();
  const transport: Transport = async (method, path) => {
    if (!state.online) throw new RelayError(503, OFFLINE);
    if (path === "/v1/events") {
      let end = () => undefined as void;
      const ended = new Promise<void>((r) => (end = r));
      streams.add(end);
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield new TextEncoder().encode(": hello\n\n");
          await ended;
        })(),
      };
    }
    if (path === "/v1/health") return json(200, { version: "1", startedAt: state.daemon, lastEventId: 0, editors: [] });
    if (path === "/v1/ext/studio/lock") return json(200, { whole: false, sensitive: false, locked: false, sensitiveOpen: true });
    if (path === "/v1/ext/studio/sessions") return json(200, { sessions: SESSIONS });
    if (path.startsWith("/v1/ext/studio/sessions/s1")) {
      state.syncs++;
      return json(200, { ...SESSIONS[0], transcript: [{ kind: "user", text: state.said, at: "2026-11-04T12:00:00Z" }], draft: "" });
    }
    if (path === "/v1/ext/studio/settings") return json(200, { theme: "ue-mcp", route: "key", provider: "anthropic", model: "m", effort: "high" });
    return json(method === "GET" ? 404 : 409, { error: "no" });
  };
  return {
    state,
    transport,
    /** The daemon stops: the relay says the project is offline, and the stream ends. */
    stop() {
      state.online = false;
      streams.forEach((end) => end());
      streams.clear();
    },
    /** A new daemon answers. */
    start(said = state.said) {
      state.daemon = `${state.daemon}'`;
      state.said = said;
      state.online = true;
    },
  };
}

/** Let `ms` of fake time pass, promises settling between timers. */
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

const line = () => screen.queryByTestId("connection-line");
const panel = () => screen.queryByText("ue-mcp on your computer is offline");

beforeEach(() => {
  store.clear();
  // The key the pairing was made with: without it the app drops the pairing at startup.
  store.set("phone", JSON.stringify({ jwk: {}, publicKey: "phone" }));
  store.set("trusted", JSON.stringify({ k1: { pairedAt: "2026-11-04T12:00:00Z" } }));
  store.set("selected", JSON.stringify(DEVICE));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function app() {
  const { default: App } = await import("../App");
  render(<App />);
  await tick(50);
}

describe("the project away when the app opens", () => {
  it("says Reconnecting, then the sessions with no banner once it answers, without a touch", async () => {
    const c = computer();
    c.stop();
    fixture.transport = c.transport;
    await app();
    await tick(1000);
    expect(line()?.textContent).toContain("Reconnecting to ue-mcp");
    expect(screen.queryByText(OFFLINE)).toBeNull();
    expect(panel()).toBeNull();
    // Still only the line well into the wait.
    await tick(REMOTE_RECONNECT_MS - 5000);
    expect(line()).toBeTruthy();
    expect(panel()).toBeNull();
    // Back after the daemon's update restart.
    c.start();
    await tick(6000);
    expect(screen.getByLabelText("Door that opens")).toBeTruthy();
    expect(line()).toBeNull();
    expect(panel()).toBeNull();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it("shows the offline panel only after the wait, and clears it when the project answers", async () => {
    const c = computer();
    c.stop();
    fixture.transport = c.transport;
    await app();
    await tick(REMOTE_RECONNECT_MS + 3000);
    expect(panel()).toBeTruthy();
    expect(screen.queryByText(OFFLINE)).toBeNull();
    c.start();
    await tick(6000);
    expect(panel()).toBeNull();
    expect(screen.getByLabelText("Door that opens")).toBeTruthy();
  });
});

describe("the daemon restarting under an open session", () => {
  it("keeps the transcript under the line, then reads the session again from the new daemon", async () => {
    const c = computer();
    fixture.transport = c.transport;
    await app();
    await tick(100);
    fireEvent.click(screen.getByLabelText("Door that opens"));
    await tick(100);
    expect(screen.getByText("Make the door open")).toBeTruthy();
    c.stop();
    await tick(2000);
    expect(line()?.textContent).toContain("Reconnecting to ue-mcp");
    expect(screen.getByText("Make the door open")).toBeTruthy();
    expect(screen.queryByText(OFFLINE)).toBeNull();
    c.start("Make the door open both ways");
    await tick(6000);
    expect(line()).toBeNull();
    expect(screen.getByText("Make the door open both ways")).toBeTruthy();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });
});

describe("the chat's reads", () => {
  it("never shows the relay's offline answer, and reads again on its own", async () => {
    const api = fakeApi();
    api.sessions.mockRejectedValueOnce(new HttpError(503, OFFLINE)).mockRejectedValueOnce(new RelayError(503, OFFLINE)).mockResolvedValue({ sessions: SESSIONS });
    api.settings.mockResolvedValue({ route: "key" });
    renderInProject(<Chat />, api);
    await tick(10);
    expect(screen.queryByText(OFFLINE)).toBeNull();
    await tick(RETRY_MS);
    expect(screen.queryByLabelText("Door that opens")).toBeNull();
    await tick(2 * RETRY_MS);
    expect(screen.getByLabelText("Door that opens")).toBeTruthy();
    expect(api.sessions).toHaveBeenCalledTimes(3);
  });

  it("says an action failed for ue-mcp being away in plain words", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: SESSIONS });
    api.settings.mockResolvedValue({ route: "key" });
    api.newSession.mockRejectedValue(new HttpError(503, OFFLINE));
    renderInProject(<Chat />, api);
    await tick(10);
    fireEvent.click(screen.getByText("New"));
    await tick(10);
    expect(screen.getByText(NOT_ANSWERING)).toBeTruthy();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it("says where the transcript goes when a session cannot be read, with Try again", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: SESSIONS });
    api.settings.mockResolvedValue({ route: "key" });
    api.sessionSync.mockRejectedValue(new HttpError(500, "Reading the transcript failed."));
    renderInProject(<Chat initialSession="s1" />, api);
    await tick(10);
    expect(screen.getByText("This session could not be loaded: Reading the transcript failed.")).toBeTruthy();
    api.sessionSync.mockResolvedValue(session({ transcript: [{ kind: "user", text: "Fix it", at: "2026-11-04T12:00:00Z" }] as SessionDetail["transcript"] }));
    fireEvent.click(screen.getByLabelText("Load the session again"));
    await tick(10);
    expect(screen.getByText("Fix it")).toBeTruthy();
  });

  it("reads the sessions and the open session again on a pull", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: SESSIONS });
    api.settings.mockResolvedValue({ route: "key" });
    api.sessionSync.mockResolvedValue(session({ transcript: [{ kind: "user", text: "Fix it", at: "2026-11-04T12:00:00Z" }] as SessionDetail["transcript"] }));
    const { nav } = renderInProject(<Chat />, api);
    nav.project.reconnect = vi.fn();
    await tick(10);
    const lists = api.sessions.mock.calls.length;
    fireEvent.click(screen.getByLabelText("Pull to refresh"));
    await tick(10);
    expect(api.sessions.mock.calls.length).toBe(lists + 1);
    expect(nav.project.reconnect).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Door that opens"));
    await tick(10);
    const syncs = api.sessionSync.mock.calls.length;
    fireEvent.click(screen.getByLabelText("Pull to refresh"));
    await tick(10);
    expect(api.sessionSync.mock.calls.length).toBe(syncs + 1);
  });
});
