/**
 * System back, every level, with Android's back handler mocked: overlays
 * close, a session goes to the list and a subagent thread to the main one, a
 * Settings section to the list, every other tab to Chat, the app's own pages
 * to where they were opened from, a project to the projects. Only at a root
 * does back leave, on a second press within two seconds after a toast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BackHandler } from "react-native";
import type { Transport } from "@ue-mcp-studio/client-core";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { EXIT_MS, EXIT_TOAST, resetBack } from "../src/back";
import { Sheet } from "../src/ui";
import { Chat } from "../src/views/Chat";
import { store } from "./mocks/secure-store";
import { fakeApi, renderInProject, session, settle } from "./helpers";

const fixture = vi.hoisted(() => ({ transport: null as Transport | null }));
vi.mock("../src/relay", async (original) => {
  const real = await original<typeof import("../src/relay")>();
  return {
    ...real,
    transportFor: () => fixture.transport!,
    account: async () => ({ devices: [DEVICE], viewers: [] }),
  };
});

const DEVICE = { id: "dev1", name: "Lyra", online: true, computerKey: "k1", lastSeen: "2026-11-04T12:00:00Z" };
const SESSIONS = [{ id: "s1", title: "Door that opens", status: "idle", createdAt: "2026-11-04T12:00:00Z", updatedAt: "2026-11-04T12:05:00Z", archived: false, awaiting: 0, agents: { total: 0, running: 0 } }];

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});

/** A daemon with one session, no lock, and a stream that stays open. */
const daemon: Transport = async (method, path) => {
  if (path === "/v1/events") return { status: 200, headers: {}, body: (async function* () { await new Promise(() => undefined); })() };
  if (path === "/v1/health") return json(200, { version: "1", startedAt: "a", lastEventId: 0, editors: [] });
  if (path === "/v1/ext/studio/lock") return json(200, { whole: false, sensitive: false, locked: false, sensitiveOpen: true });
  if (path === "/v1/ext/studio/sessions") return json(200, { sessions: SESSIONS });
  if (path.startsWith("/v1/ext/studio/sessions/s1")) return json(200, { ...SESSIONS[0], transcript: [{ kind: "user", text: "Make the door open", at: "2026-11-04T12:00:00Z" }], draft: "" });
  if (path === "/v1/ext/studio/settings") return json(200, { theme: "ue-mcp", route: "key", provider: "anthropic", model: "m", effort: "high" });
  return json(method === "GET" ? 404 : 409, { error: "no" });
};

let press: (() => boolean | null | undefined) | null = null;
beforeEach(() => {
  press = null;
  resetBack();
  vi.spyOn(BackHandler, "addEventListener").mockImplementation((_e, h) => {
    press = h as unknown as () => boolean;
    return { remove: () => void (press = null) };
  });
  store.clear();
  fixture.transport = daemon;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One press of the system back button: whether the app took it (false: the system leaves the app). */
function back(): boolean {
  let taken = false;
  act(() => void (taken = press?.() ?? false));
  return taken;
}

async function app() {
  const { default: App } = await import("../App");
  render(<App />);
  for (let i = 0; i < 6; i++) await settle();
}

const paired = (selected = true) => {
  // The key the pairing was made with: without it the app drops the pairing at startup.
  store.set("phone", JSON.stringify({ jwk: {}, publicKey: "phone" }));
  store.set("trusted", JSON.stringify({ k1: { pairedAt: "2026-11-04T12:00:00Z" } }));
  if (selected) store.set("selected", JSON.stringify(DEVICE));
};

describe("back at a root", () => {
  it("leaves only on a second press within two seconds, after the toast", async () => {
    await app();
    expect(screen.getByText("Scan pairing code")).toBeTruthy();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(back()).toBe(true);
    expect(screen.getByText(EXIT_TOAST)).toBeTruthy();
    vi.setSystemTime(Date.now() + EXIT_MS + 1);
    // Too late: the toast again, still in the app.
    expect(back()).toBe(true);
    vi.setSystemTime(Date.now() + 500);
    expect(back()).toBe(false);
  });

  it("opened straight into the last project, its sessions list is the root", async () => {
    paired();
    await app();
    expect(await screen.findByLabelText("Door that opens")).toBeTruthy();
    expect(back()).toBe(true);
    expect(screen.getByText(EXIT_TOAST)).toBeTruthy();
    expect(back()).toBe(false);
  });
});

describe("back inside a project", () => {
  it("goes from a session to the sessions list", async () => {
    paired();
    await app();
    fireEvent.click(await screen.findByLabelText("Door that opens"));
    await settle();
    expect(screen.getByText("Make the door open")).toBeTruthy();
    expect(back()).toBe(true);
    await settle();
    expect(screen.queryByText("Make the door open")).toBeNull();
    expect(screen.getByLabelText("Door that opens")).toBeTruthy();
    expect(screen.queryByText(EXIT_TOAST)).toBeNull();
  });

  it("closes the drawer, then takes Plugins and a Settings section up to Chat", async () => {
    paired();
    await app();
    await screen.findByLabelText("Door that opens");
    fireEvent.click(screen.getByLabelText("Open navigation"));
    // The drawer stays mounted when closed, taking no touches.
    const drawer = () => getComputedStyle(screen.getByLabelText("Close navigation").parentElement!.parentElement!).pointerEvents;
    expect(drawer()).not.toBe("none");
    expect(back()).toBe(true);
    expect(drawer()).toBe("none");

    fireEvent.click(screen.getByLabelText("Open navigation"));
    fireEvent.click(screen.getAllByLabelText("Plugins")[0]);
    await settle();
    expect(screen.getAllByText("Plugins").length).toBeGreaterThan(0);
    expect(back()).toBe(true);
    await settle();
    expect(screen.getAllByText("Chat").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Door that opens")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Open navigation"));
    fireEvent.click(screen.getAllByLabelText("Settings")[0]);
    await settle();
    fireEvent.click(screen.getByLabelText("General"));
    await settle();
    expect(screen.getByLabelText("All settings")).toBeTruthy();
    expect(back()).toBe(true);
    await settle();
    expect(screen.queryByLabelText("All settings")).toBeNull();
    expect(screen.getByLabelText("Settings sections")).toBeTruthy();
    expect(back()).toBe(true);
    await settle();
    expect(screen.getByLabelText("Door that opens")).toBeTruthy();
  });

  it("goes from a project opened from the list back to the projects", async () => {
    paired(false);
    await app();
    fireEvent.click(await screen.findByText(/^Lyra/));
    await screen.findByLabelText("Door that opens");
    expect(back()).toBe(true);
    await settle();
    expect(screen.getByText("Choose the project to open in Studio.")).toBeTruthy();
    // The projects list is a root.
    expect(back()).toBe(true);
    expect(screen.getByText(EXIT_TOAST)).toBeTruthy();
  });
});

describe("back on the app's own pages", () => {
  it("goes from About to Paired devices to the projects, and from the scanner to where it opened", async () => {
    paired(false);
    await app();
    await screen.findByText("Choose the project to open in Studio.");
    fireEvent.click(screen.getByLabelText("Paired devices"));
    await settle();
    fireEvent.click(screen.getByText("About"));
    await settle();
    expect(back()).toBe(true);
    await settle();
    expect(screen.getAllByText("Paired devices").length).toBeGreaterThan(0);
    expect(back()).toBe(true);
    await settle();
    expect(screen.getByText("Choose the project to open in Studio.")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Pair another computer"));
    await settle();
    expect(screen.getByText("Scan pairing code")).toBeTruthy();
    expect(back()).toBe(true);
    await settle();
    expect(screen.getByText("Choose the project to open in Studio.")).toBeTruthy();
  });
});

describe("back over overlays", () => {
  it("closes a sheet before anything under it", () => {
    const closed = vi.fn();
    renderInProject(
      <Sheet open title="Model" onClose={closed}>
        {null}
      </Sheet>,
    );
    expect(back()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("closes a session's menu", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: SESSIONS });
    renderInProject(<Chat />, api);
    await settle();
    fireEvent.click(screen.getByLabelText("Session actions"));
    expect(screen.getByLabelText("Rename")).toBeTruthy();
    expect(back()).toBe(true);
    expect(screen.queryByLabelText("Rename")).toBeNull();
  });

  it("goes from a subagent's thread to the main thread, then to the sessions", async () => {
    const api = fakeApi();
    const agent = { kind: "tool", call: { id: "a1", name: "agent", input: { description: "Find the hinge", prompt: "x" }, outcome: "done", startedAt: "2026-11-04T12:00:00Z", endedAt: "2026-11-04T12:01:00Z", result: "ok" } } as TranscriptEntry;
    api.sessions.mockResolvedValue({ sessions: SESSIONS });
    api.sessionSync.mockResolvedValue(session({ transcript: [{ kind: "user", text: "Fix it", at: "2026-11-04T12:00:00Z" } as TranscriptEntry, agent] }));
    api.settings.mockResolvedValue({ route: "key" });
    renderInProject(<Chat initialSession="s1" />, api);
    await settle();
    fireEvent.click(screen.getByText("Open thread ›"));
    await settle();
    expect(screen.getByLabelText("Back to the main thread")).toBeTruthy();
    expect(back()).toBe(true);
    await settle();
    expect(screen.queryByLabelText("Back to the main thread")).toBeNull();
    expect(screen.getByText("Fix it")).toBeTruthy();
    expect(back()).toBe(true);
    await settle();
    expect(screen.queryByText("Fix it")).toBeNull();
    // The sessions list: nothing of Chat's left to take the press.
    expect(back()).toBe(false);
  });
});
