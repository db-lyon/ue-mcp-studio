// @vitest-environment jsdom
/**
 * Settings > General > Account: anyone can sign in to their ue-mcp account
 * there, whatever STUDIO_PLAN_AVAILABLE says. It never mentions plans or remote
 * control, except Manage plan for an account that already pays.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StudioSettings } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  saveSettings: vi.fn(),
  signIn: vi.fn(async () => ({ state: "idle" })),
  startSignIn: vi.fn(),
  remoteAvailable: vi.fn(),
  billingPortal: vi.fn(),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
import { AccountCard } from "./AccountCard";
import { STUDIO_PLAN_AVAILABLE } from "@ue-mcp-studio/shared";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const settings = (account: StudioSettings["account"]) => ({ route: null, connected: {}, account }) as unknown as StudioSettings;

async function show(account: StudioSettings["account"], paid = false) {
  m.settings.mockResolvedValue(settings(account));
  m.remoteAvailable.mockResolvedValue({ available: paid, signedIn: account !== null });
  await act(async () => void render(<AccountCard />));
  return document.querySelector(".account-card")!;
}

describe("the ue-mcp account row", () => {
  it("is there with the plan flag off", () => {
    expect(STUDIO_PLAN_AVAILABLE).toBe(false);
  });

  it("signed out: a GitHub sign-in to the ue-mcp account, and no word about plans or remote control", async () => {
    const card = await show(null);
    expect(card.textContent).toContain("ue-mcp account");
    expect(card.textContent).toContain("Not signed in");
    expect(screen.getByRole("button", { name: "Sign in to your ue-mcp account" })).toBeTruthy();
    expect(card.textContent).not.toMatch(/plan|remote|studio|upgrade|pro\b/i);
  });

  it("runs the device flow inline: the code and the GitHub link", async () => {
    m.startSignIn.mockResolvedValue({ state: "pending", url: "https://github.com/login/device", userCode: "WXYZ-9876" });
    vi.spyOn(window, "open").mockReturnValue(null);
    const card = await show(null);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Sign in to your ue-mcp account" })));
    expect(m.startSignIn).toHaveBeenCalledWith("studio");
    expect(screen.getByText("WXYZ-9876")).toBeTruthy();
    expect(card.querySelector('a[href="https://github.com/login/device"]')).toBeTruthy();
    expect(card.textContent).not.toMatch(/plan|remote|upgrade/i);
  });

  it("signed in from the panel, free: the login and Sign out, no Manage plan", async () => {
    const card = await show({ login: "dev", via: "studio" });
    expect(card.textContent).toContain("Signed in as @dev");
    expect(screen.queryByRole("button", { name: "Manage plan" })).toBeNull();
    expect(card.textContent).not.toMatch(/plan|remote|upgrade/i);
    m.saveSettings.mockResolvedValue(settings(null));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Sign out" })));
    expect(m.saveSettings).toHaveBeenCalledWith({ signOut: "studio" });
    expect(card.textContent).toContain("Not signed in");
  });

  it("signed in with ue-mcp login: shown, signed out there", async () => {
    const card = await show({ login: "dev", via: "ue-mcp-login" });
    expect(card.textContent).toContain("Signed in as @dev");
    expect(card.textContent).toContain("from ue-mcp login");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("paid account: Manage plan opens the customer portal in the system browser", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    m.billingPortal.mockResolvedValue({ url: "https://billing.stripe.test/p/1" });
    await show({ login: "dev", via: "studio" }, true);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Manage plan" })));
    expect(m.billingPortal).toHaveBeenCalled();
    expect(opened).toHaveBeenCalledWith("https://billing.stripe.test/p/1", "_blank", "noopener");
  });
});
