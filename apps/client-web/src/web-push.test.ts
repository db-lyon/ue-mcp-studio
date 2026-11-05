// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DEVICE_NOTIFY, DEFAULT_PROJECT_NOTIFY, applyProjectNotify } from "@ue-mcp-studio/shared";
import { base64UrlBytes, pushPrefs, syncWebPush } from "./web-push";

afterEach(() => vi.unstubAllGlobals());

describe("web push", () => {
  it("sends the relay only the rules: event kinds on, muted projects, quiet hours and time zone", () => {
    const project = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { events: { "turn.finished": false } });
    const p = pushPrefs({ ...DEFAULT_DEVICE_NOTIFY, mutedProjects: ["Vale"], quiet: { on: true, from: "22:00", to: "07:00" } }, project, "Europe/Paris");
    expect(p.kinds).not.toContain("turn.finished");
    expect(p.kinds).toContain("approval.waiting");
    expect(p.kinds).not.toContain("subagent.finished");
    expect(p).toMatchObject({ enabled: true, muted: ["Vale"], tz: "Europe/Paris", onlyWhenAway: true, quiet: { on: true } });
  });

  it("decodes the relay's VAPID key", () => {
    expect([...base64UrlBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });

  it("subscribes with the relay's key and registers the subscription", async () => {
    const subscription = { toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } }) };
    const subscribe = vi.fn(async () => subscription);
    vi.stubGlobal("PushManager", function PushManager() {});
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => null, subscribe } }) } });
    const calls: Array<[string, RequestInit | undefined]> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(url.endsWith("/config") ? { vapidPublicKey: "AQID" } : { ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await syncWebPush(DEFAULT_DEVICE_NOTIFY, DEFAULT_PROJECT_NOTIFY, f)).toBe("registered");
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const body = JSON.parse(String(calls[1][1]!.body));
    expect(calls[1][0]).toBe("/api/push/register");
    expect(body).toMatchObject({ platform: "web", subscription: { endpoint: "https://push.example/abc" }, prefs: { enabled: true } });
  });

  it("does nothing when the relay has push off", async () => {
    vi.stubGlobal("PushManager", function PushManager() {});
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => null } });
    const f = vi.fn(async () => new Response(JSON.stringify({ vapidPublicKey: null }), { status: 200 })) as unknown as typeof fetch;
    expect(await syncWebPush(DEFAULT_DEVICE_NOTIFY, DEFAULT_PROJECT_NOTIFY, f)).toBe("off");
  });
});
