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
import { ensurePermission, noteInput, phoneInUse, resetPhoneNotifyState, showNotice } from "../src/notifications/useNotifications";
import { store } from "./mocks/secure-store";
import { renderArea, settled } from "./area-b";
import { AppState } from "react-native";

const AppStateRef = () => AppState;
const ensureAsked = () => (g.__studioNotifyAsks ?? 0) > 0;

type Req = { title: string; body: string; sound: string; vibrate: string; tag: string; data: Record<string, unknown> };
const g = globalThis as { __studioNotifications?: Req[]; __studioNotifyPermission?: string; __studioNotifyAnswer?: string; __studioNotifyAsks?: number; __studioNotifySettingsOpened?: number };

beforeEach(() => {
  resetNotifyState();
  resetPhoneNotifyState();
  delete g.__studioNotifyPermission;
  delete g.__studioNotifyAnswer;
  g.__studioNotifyAsks = 0;
  g.__studioNotifySettingsOpened = 0;
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
    expect((await showNotice({ ...notice, id: "m2", sessionId: "s2" }, device, fakeApi()))?.shown).toBe(false);
    resetNotifyState();
    prefs({ quiet: { on: true, from: "00:00", to: "00:00" } });
    expect((await showNotice({ ...notice, id: "m3" }, device, fakeApi()))?.shown).toBe(false);
    resetNotifyState();
    // Away on: the app in front and just touched is not a reason; only another device in use is.
    prefs({ onlyWhenAway: true });
    noteInput();
    expect((await showNotice({ ...notice, id: "m4" }, device, fakeApi()))?.shown).toBe(true);
    expect((await showNotice({ ...notice, id: "n2", active: ["phone"] }, device, fakeApi()))?.shown).toBe(true);
    expect(await showNotice({ ...notice, id: "n3", active: ["desktop"] }, device, fakeApi())).toMatchObject({ shown: false, why: "desktop-active" });
    expect(await showNotice({ ...notice, id: "n4", active: ["browser"] }, device, fakeApi())).toMatchObject({ shown: false, why: "active" });
    resetNotifyState();
    // Away off: nothing in use keeps it off.
    prefs({ onlyWhenAway: false });
    expect((await showNotice({ ...notice, id: "n5", active: ["desktop", "browser"] }, device, fakeApi()))?.shown).toBe(true);
    expect(g.__studioNotifications).toHaveLength(3);
  });

  it("reports the phone's input age with what it did", async () => {
    prefs({ onlyWhenAway: true });
    const api = fakeApi();
    noteInput();
    await showNotice({ ...notice, active: ["desktop"] }, device, api);
    expect(api.notifyDelivery).toHaveBeenCalledWith(expect.objectContaining({ shown: false, why: "desktop-active", inputAgeMs: expect.any(Number) }));
  });
});

describe("each notice once on the phone", () => {
  const notice: Notice = { id: "once", kind: "playtest.finished", project: "StudioE2E", at: new Date().toISOString(), title: "Playtest passed", text: "Smoke: every step passed.", target: {}, active: [] };
  const fakeApi = () =>
    ({ notifications: async (): Promise<NotificationsState> => ({ project: "StudioE2E", prefs: DEFAULT_PROJECT_NOTIFY, recent: [], titles: {} }), notifyDelivery: vi.fn(async () => undefined) }) as unknown as SettingsApi;
  const device = { id: "dev1" };

  it("decides a notice once however often the stream or a remount brings it back, and shows one notification", async () => {
    store.set(DEVICE_PREFS_KEY, JSON.stringify({ ...DEFAULT_DEVICE_NOTIFY, onlyWhenAway: false }));
    const api = fakeApi();
    expect((await showNotice(notice, device, api))?.shown).toBe(true);
    expect(await showNotice(notice, device, api)).toBeNull();
    expect(await showNotice({ ...notice }, device, fakeApi())).toBeNull();
    expect(api.notifyDelivery).toHaveBeenCalledTimes(1);
    expect(g.__studioNotifications).toHaveLength(1);
  });

  it("skips what the daemon's backlog replays from before the app started, and still shows a test", async () => {
    store.set(DEVICE_PREFS_KEY, JSON.stringify({ ...DEFAULT_DEVICE_NOTIFY, onlyWhenAway: false }));
    const api = fakeApi();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(await showNotice({ ...notice, id: "old", at: old }, device, api)).toBeNull();
    expect(api.notifyDelivery).not.toHaveBeenCalled();
    expect((await showNotice({ ...notice, id: "t1", at: old, test: { device: "phone" } }, device, api))?.shown).toBe(true);
  });
});

describe("the phone in use", () => {
  it("is the app in front and touched within two minutes", () => {
    expect(phoneInUse()).toEqual({ active: false });
    noteInput();
    expect(phoneInUse().active).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 121_000);
    expect(phoneInUse().active).toBe(false);
    vi.useRealTimers();
    noteInput();
    vi.spyOn(AppStateRef(), "currentState", "get").mockReturnValue("background");
    expect(phoneInUse().active).toBe(false);
  });
});

describe("Android's notification permission", () => {
  it("asks once while the system can still ask, never once granted or denied", async () => {
    g.__studioNotifyPermission = "undetermined";
    g.__studioNotifyAnswer = "granted";
    expect(await ensurePermission()).toBe("granted");
    expect(await ensurePermission()).toBe("granted");
    expect(g.__studioNotifyAsks).toBe(1);
    resetPhoneNotifyState();
    g.__studioNotifyAsks = 0;
    g.__studioNotifyPermission = "denied";
    expect(await ensurePermission(true)).toBe("denied");
    expect(g.__studioNotifyAsks).toBe(0);
  });

  it("does not ask again in the same run after a dismissal, unless the owner asks", async () => {
    g.__studioNotifyPermission = "undetermined";
    g.__studioNotifyAnswer = "undetermined";
    await ensurePermission();
    await ensurePermission();
    expect(g.__studioNotifyAsks).toBe(1);
    await ensurePermission(true);
    expect(g.__studioNotifyAsks).toBe(2);
  });

  it("asks when Settings > Notifications opens with notifications on", async () => {
    g.__studioNotifyPermission = "undetermined";
    g.__studioNotifyAnswer = "granted";
    renderArea("settings-notifications", (daemon) => <SettingsScreen daemon={daemon} section="notifications" onSection={vi.fn()} onTheme={vi.fn()} />);
    await settled(6);
    fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
    await settled();
    expect(g.__studioNotifyAsks).toBe(1);
    expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull();
  });

  it("asks when notifications are turned on", async () => {
    store.set(DEVICE_PREFS_KEY, JSON.stringify({ enabled: false }));
    g.__studioNotifyPermission = "undetermined";
    g.__studioNotifyAnswer = "granted";
    renderArea("settings-notifications-off", (daemon) => <SettingsScreen daemon={daemon} section="notifications" onSection={vi.fn()} onTheme={vi.fn()} />);
    await settled(6);
    fireEvent.click(sw("Notifications on this device"));
    await settled(6);
    expect(ensureAsked()).toBe(true);
  });

  it("the test button asks first when not allowed yet", async () => {
    g.__studioNotifyPermission = "undetermined";
    g.__studioNotifyAnswer = "granted";
    renderArea("settings-notifications", (daemon) => <SettingsScreen daemon={daemon} section="notifications" onSection={vi.fn()} onTheme={vi.fn()} />);
    await settled(6);
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    await settled();
    expect(g.__studioNotifyAsks).toBeGreaterThanOrEqual(1);
  });

  it("denied: a row that opens the app's notification settings", async () => {
    g.__studioNotifyPermission = "denied";
    renderArea("settings-notifications", (daemon) => <SettingsScreen daemon={daemon} section="notifications" onSection={vi.fn()} onTheme={vi.fn()} />);
    await settled(6);
    expect(screen.getByText("Notifications are blocked for Studio. Allow them in the system's settings.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open notification settings" }));
    await settled();
    expect(g.__studioNotifySettingsOpened).toBe(1);
    expect(g.__studioNotifyAsks).toBe(0);
  });
});

