// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_PROJECT_NOTIFY, applyProjectNotify, type ProjectNotifyPrefs } from "@ue-mcp-studio/shared";
import { NotificationsSection } from "./NotificationsSection";
import { SessionRow } from "../../chat/SessionRow";
import { DEVICE_PREFS_KEY, readDevicePrefs, resetNotifyState } from "../../notify";

let prefs: ProjectNotifyPrefs;
let puts: unknown[];
beforeEach(() => {
  prefs = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["s9"] });
  puts = [];
  resetNotifyState();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/notifications") && init?.method === "PUT") {
        const u = JSON.parse(String(init.body));
        puts.push(u);
        prefs = applyProjectNotify(prefs, u);
      }
      return new Response(JSON.stringify({ project: "Vale", prefs, recent: [], titles: { s9: "Old experiment" } }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  delete window.ue;
  vi.unstubAllGlobals();
});

const sw = (name: string) => screen.getByRole("switch", { name });

describe("Settings > Notifications", () => {
  it("lists every event with its default, and a change goes to the project", async () => {
    render(<NotificationsSection />);
    await screen.findByText("Shared by every device paired with Vale.");
    expect(sw("Turn finished").getAttribute("aria-checked")).toBe("true");
    expect(sw("Subagent finished").getAttribute("aria-checked")).toBe("false");
    expect(sw("Project went offline").getAttribute("aria-checked")).toBe("false");
    await act(async () => void fireEvent.click(sw("Subagent finished")));
    expect(puts).toEqual([{ events: { "subagent.finished": true } }]);
    expect(sw("Subagent finished").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps this device's choices in this device's storage", async () => {
    render(<NotificationsSection />);
    await screen.findByText("Shared by every device paired with Vale.");
    fireEvent.click(sw("Only when I'm away"));
    fireEvent.click(screen.getByRole("radio", { name: "Event and project" }));
    fireEvent.click(sw("Mute Vale on this device"));
    fireEvent.click(sw("Quiet hours"));
    fireEvent.change(screen.getByLabelText("Quiet hours from"), { target: { value: "21:30" } });
    const stored = readDevicePrefs();
    expect(stored).toMatchObject({ onlyWhenAway: false, privacy: "minimal", mutedProjects: ["Vale"], quiet: { on: true, from: "21:30", to: "07:00" } });
    expect(JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY)!).privacy).toBe("minimal");
    expect(puts).toEqual([]);
  });

  it("turning the device off disables its other choices", async () => {
    render(<NotificationsSection />);
    await screen.findByText("Shared by every device paired with Vale.");
    fireEvent.click(sw("Notifications on this device"));
    expect((sw("Only when I'm away") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists muted sessions by title and unmutes one", async () => {
    render(<NotificationsSection />);
    await screen.findByText("Old experiment");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Unmute" })));
    expect(puts).toEqual([{ unmute: ["s9"] }]);
    expect(await screen.findByText("None. Mute a session from its menu in the session list.")).toBeTruthy();
  });

  it("asks the browser for permission on a plain page", async () => {
    const requestPermission = vi.fn(async () => "granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    render(<NotificationsSection />);
    await act(async () => void fireEvent.click(await screen.findByRole("button", { name: "Allow notifications" })));
    expect(requestPermission).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull();
  });

  it("needs no browser permission in Studio's window", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
    window.ue = { studio: { notify: vi.fn() } as never, studioWindow: true };
    render(<NotificationsSection />);
    await screen.findByText(/Studio's window shows Windows notifications/);
    expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull();
  });
});

describe("the session menu", () => {
  const s = { id: "s1", title: "Fix the door", status: "idle", createdAt: "x", updatedAt: new Date().toISOString(), waitingCause: null, archived: false } as never;
  it("mutes and unmutes a session's notifications", async () => {
    render(<SessionRow s={s} selected={false} onOpen={vi.fn()} onChanged={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => void fireEvent.click(await screen.findByRole("menuitem", { name: "Mute notifications" })));
    expect(puts).toEqual([{ mute: ["s1"] }]);
    expect(screen.getByLabelText("Notifications muted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    await act(async () => void fireEvent.click(screen.getByRole("menuitem", { name: "Unmute notifications" })));
    expect(puts.at(-1)).toEqual({ unmute: ["s1"] });
  });
});
