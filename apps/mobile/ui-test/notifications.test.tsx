/**
 * Notifications on the phone: Settings > Notifications (this phone's choices
 * kept on the phone, the project's events on the computer), the session menu's
 * mute, and the decision and request for one notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { DEFAULT_DEVICE_NOTIFY, DEFAULT_PROJECT_NOTIFY, applyProjectNotify, type Notice, type NotificationsState } from "@ue-mcp-studio/shared";
import type { SettingsApi } from "@ue-mcp-studio/client-core";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen";
import { SessionRow } from "../src/chat/SessionRow";
import { DEVICE_PREFS_KEY, loadProjectNotify, resetNotifyState } from "../src/notifications/state";
import { showNotice } from "../src/notifications/useNotifications";
import { store } from "./mocks/secure-store";
import { renderArea, settled } from "./area-b";

type Req = { title: string; body: string; sound: string; vibrate: string; tag: string; data: Record<string, unknown> };
const g = globalThis as { __studioNotifications?: Req[] };

beforeEach(() => {
  resetNotifyState();
  store.delete(DEVICE_PREFS_KEY);
  g.__studioNotifications = [];
});
afterEach(() => vi.restoreAllMocks());

const sw = (name: string) => screen.getByLabelText(name);
const checked = (name: string) => sw(name).getAttribute("aria-checked");

describe("Settings > Notifications on the phone", () => {
  it("lists the project's events at their defaults and its muted session, and a change goes to the computer", async () => {
    const { writes } = renderArea("settings-notifications", (daemon) => <SettingsScreen daemon={daemon} section="notifications" onSection={vi.fn()} onTheme={vi.fn()} />);
    await settled(6);
    expect(screen.getByText("Shared by every device paired with StudioE2E.")).toBeTruthy();
    expect(checked("Turn finished")).toBe("true");
    expect(checked("Subagent finished")).toBe("false");
    expect(screen.getByText("Bake lighting overnight")).toBeTruthy();
    fireEvent.click(sw("Subagent finished"));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ method: "PUT", path: "/v1/ext/studio/notifications", json: { events: { "subagent.finished": true } } }));
  });

  it("keeps this phone's choices on the phone: away, what it shows, sound, vibration, quiet hours, the project muted by its id", async () => {
    const { writes } = renderArea("settings-notifications", (daemon) => <SettingsScreen daemon={daemon} section="notifications" onSection={vi.fn()} onTheme={vi.fn()} />);
    await settled(6);
    fireEvent.click(sw("Only when I'm away"));
    fireEvent.click(screen.getByRole("radio", { name: "Event and project" }));
    fireEvent.click(screen.getByRole("radio", { name: "Silent" }));
    fireEvent.click(screen.getByRole("radio", { name: "Short" }));
    fireEvent.click(sw("Mute StudioE2E on this device"));
    fireEvent.click(sw("Quiet hours"));
    await settled();
    const kept = JSON.parse(store.get(DEVICE_PREFS_KEY)!);
    expect(kept).toMatchObject({ onlyWhenAway: false, privacy: "minimal", sound: "none", vibrate: "short", mutedProjects: ["dev1"], quiet: { on: true } });
    expect(screen.getByLabelText("Quiet hours from")).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("dims the phone's choices when notifications are off on it", async () => {
    store.set(DEVICE_PREFS_KEY, JSON.stringify({ enabled: false }));
    renderArea("settings-notifications-off", (daemon) => <SettingsScreen daemon={daemon} section="notifications" onSection={vi.fn()} onTheme={vi.fn()} />);
    await settled(6);
    expect(checked("Notifications on this device")).toBe("false");
    expect(sw("Only when I'm away").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("the session menu on the phone", () => {
  it("mutes a session's notifications", async () => {
    const s = { id: "qa-session", title: "Door hinge fix", status: "idle", createdAt: "x", updatedAt: new Date().toISOString(), waitingCause: null, archived: false } as never;
    const { writes } = renderArea("settings-notifications", <SessionRow s={s} selected={false} onOpen={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Session actions"));
    await settled(6);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mute notifications" }));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ method: "PUT", path: "/v1/ext/studio/notifications", json: { mute: ["qa-session"] } }));
  });
});

describe("one notice on the phone", () => {
  const notice: Notice = { id: "n1", kind: "turn.finished", project: "StudioE2E", at: "x", sessionId: "s1", title: "Done: Fix the door", text: "The door opens now.", target: { sessionId: "s1" }, active: [] };
  const fakeApi = (prefs = DEFAULT_PROJECT_NOTIFY) =>
    ({ notifications: async (): Promise<NotificationsState> => ({ project: "StudioE2E", prefs, recent: [], titles: {} }), notifyDelivery: vi.fn(async () => undefined) }) as unknown as SettingsApi;
  const device = { id: "dev1" };
  const prefs = (over: object) => store.set(DEVICE_PREFS_KEY, JSON.stringify({ ...DEFAULT_DEVICE_NOTIFY, onlyWhenAway: false, ...over }));

  it("asks for a notification with the title, project and text, its sound and vibration, and the session to open", async () => {
    prefs({ sound: "soft", vibrate: "short" });
    const api = fakeApi();
    await loadProjectNotify(api);
    expect((await act(() => showNotice(notice, device, api)))?.shown).toBe(true);
    // What the phone did goes back to the computer's log.
    expect(api.notifyDelivery).toHaveBeenCalledWith(expect.objectContaining({ noticeId: "n1", kind: "turn.finished", device: "phone", shown: true, via: "phone" }));
    expect(g.__studioNotifications).toEqual([
      { title: "Done: Fix the door", body: "StudioE2E: The door opens now.", sound: "soft", vibrate: "short", tag: "uemcp:turn.finished:StudioE2E", data: { deviceId: "dev1", kind: "turn.finished", sessionId: "s1" } },
    ]);
  });

  it("shows only the event and project when details are hidden", async () => {
    prefs({ privacy: "minimal" });
    await showNotice(notice, device, fakeApi());
    expect(g.__studioNotifications?.[0]).toMatchObject({ title: "Turn finished", body: "StudioE2E" });
  });

  it("stays quiet for a muted session, a muted project, quiet hours, while the app is in front, and while Studio's window is in use", async () => {
    const api = fakeApi(applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["s1"] }));
    await loadProjectNotify(api);
    prefs({});
    expect(await showNotice(notice, device, api)).toMatchObject({ shown: false, why: "session-muted" });
    expect(api.notifyDelivery).toHaveBeenCalledWith(expect.objectContaining({ shown: false, why: "session-muted" }));
    resetNotifyState();
    prefs({ mutedProjects: ["dev1"] });
    expect((await showNotice({ ...notice, sessionId: "s2" }, device, fakeApi()))?.shown).toBe(false);
    resetNotifyState();
    prefs({ quiet: { on: true, from: "00:00", to: "00:00" } });
    expect((await showNotice(notice, device, fakeApi()))?.shown).toBe(false);
    resetNotifyState();
    prefs({ onlyWhenAway: true });
    expect((await showNotice(notice, device, fakeApi()))?.shown).toBe(false);
    resetNotifyState();
    prefs({ onlyWhenAway: true });
    vi.spyOn(await import("react-native").then((m) => m.AppState), "currentState", "get").mockReturnValue("background");
    expect((await showNotice({ ...notice, active: ["desktop"] }, device, fakeApi()))?.shown).toBe(false);
    expect((await showNotice(notice, device, fakeApi()))?.shown).toBe(true);
    expect(g.__studioNotifications).toHaveLength(1);
  });
});
