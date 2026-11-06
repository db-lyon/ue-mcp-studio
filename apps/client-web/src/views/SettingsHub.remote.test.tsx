// @vitest-environment jsdom
/**
 * Remote control in Settings for each state: REMOTE_PLAN_OFFERED off or on,
 * signed out, a free or a paid account. With the flag off only a paid account
 * sees it; with it on (as shipped) a signed-out computer gets the sign-in and
 * a free account the Upgrade action, and Pro is never named.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@ue-mcp-studio/shared", async (original) => {
  const real = await original<typeof import("@ue-mcp-studio/shared")>();
  return {
    ...real,
    get REMOTE_PLAN_OFFERED() {
      return flag.on;
    },
  };
});
const m = vi.hoisted(() => ({
  settings: vi.fn(async () => ({ route: null })),
  remoteAvailable: vi.fn(async (): Promise<{ available: boolean; signedIn?: boolean }> => ({ available: true })),
  signIn: vi.fn(async () => ({ state: "idle" })),
  startSignIn: vi.fn(),
  billingCheckout: vi.fn(),
}));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
vi.mock("./settings/GeneralSection", () => ({ GeneralSection: () => <div>GeneralSection body</div> }));
vi.mock("./settings/RemoteSection", async (original) => ({ ...(await original<typeof import("./settings/RemoteSection")>()), RemoteSection: () => <div>RemoteSection body</div> }));
import { SettingsHub } from "./SettingsHub";
import { STUDIO_PLAN_URL } from "@ue-mcp-studio/shared";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  flag.on = true;
});

type Account = "signed-out" | "free" | "paid";

async function open(on: boolean, account: Account, section: "remote" | "notifications" = "remote") {
  flag.on = on;
  m.remoteAvailable.mockResolvedValue({ available: account === "paid", signedIn: account !== "signed-out" });
  await act(async () => void render(<SettingsHub daemon={{} as never} section={section} onSection={vi.fn()} onTheme={vi.fn()} />));
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  return {
    rail: [...nav.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent),
    content: document.querySelector(".cfg-content")!,
  };
}

describe("Settings > Remote control", () => {
  it.each(["signed-out", "free"] as const)("flag off, %s: not listed, its name opens General, nothing about plans", async (account) => {
    const { rail, content } = await open(false, account);
    expect(rail).not.toContain("Remote control");
    expect(screen.getByText("GeneralSection body")).toBeTruthy();
    expect(content.textContent).not.toMatch(/remote|plan|upgrade/i);
  });

  it.each([false, true])("paid account (flag %s): listed under Studio, after Notifications, and opens the working section", async (on) => {
    const { rail } = await open(on, "paid");
    expect(rail.slice(0, 3)).toEqual(["General", "Notifications", "Remote control"]);
    expect(screen.getByText("RemoteSection body")).toBeTruthy();
  });

  it("flag on, signed out: listed, with the ue-mcp account sign-in inline and nothing that runs", async () => {
    const { rail, content } = await open(true, "signed-out");
    expect(rail.slice(0, 3)).toEqual(["General", "Notifications", "Remote control"]);
    expect(screen.queryByText("RemoteSection body")).toBeNull();
    expect(screen.getByText("Sign in to your ue-mcp account to use remote control.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to your ue-mcp account" })).toBeTruthy();
    expect(content.querySelector("[role=switch], .remote-qr, .upgrade")).toBeNull();
  });

  it("flag on, signed out: the sign-in runs the device flow inline, and its end asks again, showing the plan's answer", async () => {
    m.startSignIn.mockResolvedValue({ state: "pending", url: "https://github.com/login/device", userCode: "ABCD-1234" });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    await open(true, "signed-out");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Sign in to your ue-mcp account" })));
    expect(m.startSignIn).toHaveBeenCalledWith("studio");
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByText(/sign in to your ue-mcp account:/)).toBeTruthy();
    // Approved on GitHub: the form reports done, the hook asks the agent again, a free account gets the Upgrade action.
    m.remoteAvailable.mockResolvedValue({ available: false, signedIn: true });
    m.signIn.mockResolvedValue({ state: "done", login: "dev" } as never);
    await act(async () => void (await new Promise((r) => setTimeout(r, 2100))));
    expect(m.remoteAvailable).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Upgrade to Remote" })).toBeTruthy();
    opened.mockRestore();
  });

  it("flag on, free account: what it does, that it needs a plan, and the Upgrade action; no plans link, nothing that runs", async () => {
    const { content } = await open(true, "free");
    expect(screen.queryByText("RemoteSection body")).toBeNull();
    expect(screen.getByText("Use this project from your phone or another computer.")).toBeTruthy();
    expect(screen.getByText("Needs the Remote plan: $5 a month or $50 a year, before tax.")).toBeTruthy();
    expect(content.querySelector(`a[href="${STUDIO_PLAN_URL}"]`)).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade to Remote" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Monthly" }).getAttribute("aria-checked")).toBe("true");
    expect(content.textContent).not.toMatch(/\bPro\b/);
    expect(content.querySelector("[role=switch], img, svg.qr, .remote-qr")).toBeNull();
  });

  it("a sign-in elsewhere in Studio asks again: settings.changed and remote.available events recheck", async () => {
    const { publishEvent } = await import("../extensions/events");
    await open(true, "signed-out");
    m.remoteAvailable.mockResolvedValue({ available: true, signedIn: true });
    await act(async () => void publishEvent({ id: 1, type: "studio.settings.changed", at: "", data: {} }));
    expect(screen.getByText("RemoteSection body")).toBeTruthy();
  });
});

describe("Settings > Notifications follows remote control", () => {
  const PLAN = "Phone and browser notifications come with remote control, on the Remote plan.";
  const has = (name: string) => screen.queryByRole("switch", { name }) !== null;

  it.each([false, true])("paid account (flag %s): paired devices' notifications too", async (on) => {
    await open(on, "paid", "notifications");
    expect(has("Turn finished") && has("Project went offline")).toBe(true);
    expect(screen.queryByText(PLAN)).toBeNull();
  });

  it("flag on, free account: this computer's notifications and the one plan line", async () => {
    await open(true, "free", "notifications");
    expect(has("Turn finished")).toBe(true);
    expect(has("Project went offline")).toBe(false);
    expect(screen.getByText(PLAN)).toBeTruthy();
  });

  it.each([[true, "signed-out"], [false, "free"], [false, "signed-out"]] as const)("flag %s, %s: this computer's notifications, no plan line", async (on, account) => {
    const { content } = await open(on, account, "notifications");
    expect(has("Turn finished")).toBe(true);
    expect(has("Project went offline")).toBe(false);
    expect(content.textContent).not.toMatch(/remote control|plan|paired/i);
  });
});
