import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_NOTIFY,
  DEFAULT_PROJECT_NOTIFY,
  applyProjectNotify,
  ACTIVE_INPUT_MS,
  decideNotice,
  deliveryLine,
  deviceNotifyOf,
  inQuietHours,
  inUse,
  inputAge,
  noticeContent,
  noticeOf,
  projectNotifyOf,
  type DeviceNotifyPrefs,
  type NotifyContext,
} from "../src/notifications.js";

const at = (hhmm: string) => new Date(2026, 10, 4, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)));
const ctx = (over: Partial<NotifyContext> = {}): NotifyContext => ({ now: at("12:00"), projectKey: "Vale", device: "desktop", ...over });
const device = (over: Partial<DeviceNotifyPrefs> = {}): DeviceNotifyPrefs => ({ ...DEFAULT_DEVICE_NOTIFY, ...over });

describe("inQuietHours", () => {
  it("is off unless turned on", () => {
    expect(inQuietHours({ on: false, from: "00:00", to: "23:59" }, at("12:00"))).toBe(false);
  });
  it("covers a range within one day, end excluded", () => {
    const q = { on: true, from: "09:00", to: "17:00" };
    expect(inQuietHours(q, at("08:59"))).toBe(false);
    expect(inQuietHours(q, at("09:00"))).toBe(true);
    expect(inQuietHours(q, at("16:59"))).toBe(true);
    expect(inQuietHours(q, at("17:00"))).toBe(false);
  });
  it("wraps past midnight", () => {
    const q = { on: true, from: "22:00", to: "07:00" };
    expect(inQuietHours(q, at("23:30"))).toBe(true);
    expect(inQuietHours(q, at("03:00"))).toBe(true);
    expect(inQuietHours(q, at("07:00"))).toBe(false);
    expect(inQuietHours(q, at("21:59"))).toBe(false);
  });
  it("is the whole day when from equals to", () => {
    expect(inQuietHours({ on: true, from: "08:00", to: "08:00" }, at("15:00"))).toBe(true);
  });
});

describe("decideNotice", () => {
  const n = { kind: "turn.finished" as const, sessionId: "s1" };
  it("shows a default-on event", () => {
    expect(decideNotice(n, DEFAULT_PROJECT_NOTIFY, device(), ctx())).toEqual({ show: true });
  });
  it("skips an event that is off by default", () => {
    expect(decideNotice({ kind: "subagent.finished" }, DEFAULT_PROJECT_NOTIFY, device(), ctx())).toEqual({ show: false, why: "event" });
  });
  it("skips everything on a device turned off", () => {
    expect(decideNotice(n, DEFAULT_PROJECT_NOTIFY, device({ enabled: false }), ctx())).toEqual({ show: false, why: "off" });
  });
  it("skips a project muted on this device only", () => {
    const d = device({ mutedProjects: ["Vale"] });
    expect(decideNotice(n, DEFAULT_PROJECT_NOTIFY, d, ctx())).toEqual({ show: false, why: "project-muted" });
    expect(decideNotice(n, DEFAULT_PROJECT_NOTIFY, d, ctx({ projectKey: "Other" }))).toEqual({ show: true });
  });
  it("skips a muted session", () => {
    const p = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["s1"] });
    expect(decideNotice(n, p, device(), ctx())).toEqual({ show: false, why: "session-muted" });
    expect(decideNotice({ ...n, sessionId: "s2" }, p, device(), ctx())).toEqual({ show: true });
  });
  it("skips during quiet hours", () => {
    const d = device({ quiet: { on: true, from: "11:00", to: "13:00" } });
    expect(decideNotice(n, DEFAULT_PROJECT_NOTIFY, d, ctx())).toEqual({ show: false, why: "quiet" });
  });
  it("away off: being in use never keeps a notice off, on any device", () => {
    const busy = { ...n, active: ["desktop", "browser", "phone"] as ("desktop" | "browser" | "phone")[] };
    for (const d of ["desktop", "browser", "phone"] as const) expect(decideNotice(busy, DEFAULT_PROJECT_NOTIFY, device({ onlyWhenAway: false }), ctx({ device: d }))).toEqual({ show: true });
  });
  it("away on: no device in use, every device shows", () => {
    for (const d of ["desktop", "browser", "phone"] as const) expect(decideNotice({ ...n, active: [] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: d }))).toEqual({ show: true });
    expect(decideNotice(n, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "phone" }))).toEqual({ show: true });
  });
  it("away on: a device never stays quiet for being in use itself", () => {
    expect(decideNotice({ ...n, active: ["desktop"] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "desktop" }))).toEqual({ show: true });
    expect(decideNotice({ ...n, active: ["phone"] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "phone" }))).toEqual({ show: true });
    expect(decideNotice({ ...n, active: ["browser"] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "browser" }))).toEqual({ show: true });
  });
  it("away on: phone and browser stay quiet while the computer is in use", () => {
    const busy = { ...n, active: ["desktop" as const] };
    expect(decideNotice(busy, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "phone" }))).toEqual({ show: false, why: "desktop-active" });
    expect(decideNotice(busy, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "browser" }))).toEqual({ show: false, why: "desktop-active" });
  });
  it("away on: the computer stays quiet while a phone or browser is in use", () => {
    expect(decideNotice({ ...n, active: ["phone" as const] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "desktop" }))).toEqual({ show: false, why: "active" });
    expect(decideNotice({ ...n, active: ["browser" as const] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "desktop" }))).toEqual({ show: false, why: "active" });
    expect(decideNotice({ ...n, active: ["desktop", "phone"] as ("desktop" | "phone")[] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "phone" }))).toEqual({ show: false, why: "desktop-active" });
  });
  it("a test ignores away mode", () => {
    expect(decideNotice({ ...n, test: { device: "phone" }, active: ["desktop"] }, DEFAULT_PROJECT_NOTIFY, device(), ctx({ device: "phone" }))).toEqual({ show: true });
  });
});

describe("inUse", () => {
  it("needs input under two minutes ago and the window focused", () => {
    expect(inUse(1_000, true)).toBe(true);
    expect(inUse(ACTIVE_INPUT_MS - 1, true)).toBe(true);
    expect(inUse(ACTIVE_INPUT_MS, true)).toBe(false);
    expect(inUse(3_900_000, true)).toBe(false);
    expect(inUse(1_000, false)).toBe(false);
    expect(inUse(undefined, true)).toBe(false);
  });
  it("puts the input age in each decision line", () => {
    expect(inputAge(undefined)).toBe("unknown");
    expect(inputAge(12_400)).toBe("12s");
    expect(inputAge(3_783_000)).toBe("63m03s");
    expect(deliveryLine({ noticeId: "n1", kind: "turn.finished", device: "phone", shown: false, why: "desktop-active", inputAgeMs: 20_000 })).toBe("notify turn.finished id=n1 device=phone suppressed rule=desktop-active input=20s");
    expect(deliveryLine({ noticeId: "n1", kind: "turn.finished", device: "desktop", shown: true, via: "window", ok: true })).toBe("notify turn.finished id=n1 device=desktop shown via=window ok=true input=unknown");
  });
});

describe("settings shapes", () => {
  it("fills missing events with defaults and drops unknown ones", () => {
    const p = projectNotifyOf({ events: { "turn.finished": false, bogus: true }, mutedSessions: ["a", "a", 3] });
    expect(p.events["turn.finished"]).toBe(false);
    expect(p.events["approval.waiting"]).toBe(true);
    expect("bogus" in p.events).toBe(false);
    expect(p.mutedSessions).toEqual(["a"]);
  });
  it("mutes and unmutes sessions", () => {
    let p = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["a", "b"], events: { "subagent.finished": true } });
    expect(p.mutedSessions).toEqual(["a", "b"]);
    expect(p.events["subagent.finished"]).toBe(true);
    p = applyProjectNotify(p, { unmute: ["a"] });
    expect(p.mutedSessions).toEqual(["b"]);
  });
  it("repairs a device's stored settings", () => {
    const d = deviceNotifyOf({ quiet: { on: true, from: "25:00", to: "06:30" }, privacy: "loud", onlyWhenAway: false });
    expect(d.quiet).toEqual({ on: true, from: "22:00", to: "06:30" });
    expect(d.privacy).toBe("full");
    expect(d.onlyWhenAway).toBe(false);
  });
});

describe("content", () => {
  const n = { kind: "approval.waiting" as const, project: "Vale", title: "Approval waiting", text: "Allow shell: npm run build?" };
  it("shows the full text with the project", () => {
    expect(noticeContent(n, "full")).toEqual({ title: "Approval waiting", body: "Vale: Allow shell: npm run build?" });
  });
  it("hides details: only the event and the project", () => {
    expect(noticeContent(n, "minimal")).toEqual({ title: "Approval waiting", body: "Vale" });
  });
  it("reads a notice from event data and refuses anything else", () => {
    expect(noticeOf({ id: "1", kind: "turn.finished", title: "t", text: "x", target: { sessionId: "s", bad: 1 }, active: ["desktop", "tv"] })).toMatchObject({ target: { sessionId: "s" }, active: ["desktop"] });
    expect(noticeOf({ id: "1", kind: "nope", title: "t", text: "x" })).toBeNull();
  });
});
