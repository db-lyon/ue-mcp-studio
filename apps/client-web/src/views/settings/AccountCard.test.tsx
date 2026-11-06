// @vitest-environment jsdom
/**
 * Settings > General > Account: anyone can sign in to their ue-mcp account
 * there, whatever STUDIO_PLAN_AVAILABLE says. It never mentions plans or remote
 * control, except Manage plan (the billing portal, where the plan is changed
 * or canceled) for an account that already pays.
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
  authMethods: vi.fn(async () => ({ email: false, github: true })),
  startEmailSignIn: vi.fn(),
  verifyEmailSignIn: vi.fn(),
  accountProfile: vi.fn(async () => ({})),
  startAccountEmail: vi.fn(),
  verifyAccountEmail: vi.fn(),
  removeAccountEmail: vi.fn(),
  unlinkGitHub: vi.fn(),
  githubLink: vi.fn(async () => ({ state: "idle" })),
  startGitHubLink: vi.fn(),
  cancelGitHubLink: vi.fn(),
}));
const { ApiError } = vi.hoisted(() => ({
  ApiError: class extends Error {
    constructor(readonly status: number, message: string, readonly body?: unknown) {
      super(message);
    }
  },
}));
vi.mock("../../api", () => ({
  api: m,
  ApiError,
  retryAfterOf: (e: unknown) => (e as { body?: { retryAfter?: number } }).body?.retryAfter ?? null,
}));
import { AccountCard } from "./AccountCard";
import { ACCOUNT_CODE_ERROR, ACCOUNT_EMAIL_MALFORMED, ACCOUNT_LAST_METHOD, ACCOUNT_SIGN_IN_HEADING, STUDIO_PLAN_AVAILABLE } from "@ue-mcp-studio/shared";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  m.authMethods.mockImplementation(async () => ({ email: false, github: true }));
  m.signIn.mockImplementation(async () => ({ state: "idle" }));
  m.githubLink.mockImplementation(async () => ({ state: "idle" }));
  m.accountProfile.mockImplementation(async () => ({}));
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

const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const emailField = () => screen.getByLabelText("Email");
const codeField = () => screen.getByLabelText(/Enter the 6-digit code/);
const click = (name: string | RegExp) => act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("email sign-in on the account row", () => {
  const offered = () => m.authMethods.mockImplementation(async () => ({ email: true, github: true }));

  it("email flag off: GitHub alone, exactly as before", async () => {
    const card = await show(null);
    expect(card.textContent).not.toContain(ACCOUNT_SIGN_IN_HEADING);
    expect(card.querySelector("input[type=email]")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to your ue-mcp account" })).toBeTruthy();
    expect(card.textContent).toContain("Sign in with GitHub.");
  });

  it("flag on: the heading, the email field and Send code, with Continue with GitHub below", async () => {
    offered();
    const card = await show(null);
    expect(card.textContent).toContain(ACCOUNT_SIGN_IN_HEADING);
    expect(emailField()).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send code" });
    const github = screen.getByRole("button", { name: "Continue with GitHub" });
    expect(send.compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(github.className).not.toContain("primary");
    expect(card.textContent).not.toMatch(/plan|remote|upgrade/i);
  });

  it("refuses a malformed address without asking the agent", async () => {
    offered();
    await show(null);
    type(emailField(), "not-an-address");
    await click("Send code");
    expect(m.startEmailSignIn).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(ACCOUNT_EMAIL_MALFORMED);
  });

  it("sends the code, then signs in inline with it: no browser hop", async () => {
    offered();
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    m.startEmailSignIn.mockResolvedValue({ ok: true, expiresInSeconds: 600 });
    m.verifyEmailSignIn.mockResolvedValue({ ok: true, login: "dev@example.com", email: "dev@example.com", created: true });
    const card = await show(null);
    type(emailField(), "dev@example.com");
    await click("Send code");
    expect(m.startEmailSignIn).toHaveBeenCalledWith("dev@example.com");
    expect(card.textContent).toContain("Enter the 6-digit code sent to dev@example.com.");
    expect(card.textContent).toContain("The code expires in 10 min.");
    expect(screen.getByRole("button", { name: "Resend code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change email" })).toBeTruthy();
    type(codeField(), "12 34 56");
    m.settings.mockResolvedValue(settings({ login: "dev@example.com", via: "studio", email: "dev@example.com", github: null }));
    await click("Sign in");
    expect(m.verifyEmailSignIn).toHaveBeenCalledWith("dev@example.com", "123456");
    expect(card.textContent).toContain("Signed in as dev@example.com");
    expect(opened).not.toHaveBeenCalled();
  });

  it("a wrong code: the service's one error, inline, and the code entry stays", async () => {
    offered();
    m.startEmailSignIn.mockResolvedValue({ ok: true, expiresInSeconds: 600 });
    m.verifyEmailSignIn.mockRejectedValue(new ApiError(400, ACCOUNT_CODE_ERROR, { error: ACCOUNT_CODE_ERROR }));
    await show(null);
    type(emailField(), "dev@example.com");
    await click("Send code");
    type(codeField(), "000000");
    await click("Sign in");
    expect(screen.getByRole("alert").textContent).toBe(ACCOUNT_CODE_ERROR);
    expect(codeField()).toBeTruthy();
  });

  it("rate limited: the wait is shown and Send code is held until retryAfter passes", async () => {
    offered();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.startEmailSignIn.mockRejectedValue(new ApiError(429, "Too many codes.", { error: "Too many codes.", retryAfter: 42 }));
      await show(null);
      type(emailField(), "dev@example.com");
      await click("Send code");
      expect(screen.getByRole("alert").textContent).toBe("Too many codes. Try again in 42 s.");
      const wait = screen.getByRole("button", { name: "Wait 42 s" }) as HTMLButtonElement;
      expect(wait.disabled).toBe(true);
      await act(async () => void vi.advanceTimersByTime(43_000));
      expect((screen.getByRole("button", { name: "Send code" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Change email goes back to the address", async () => {
    offered();
    m.startEmailSignIn.mockResolvedValue({ ok: true, expiresInSeconds: 600 });
    await show(null);
    type(emailField(), "dev@example.com");
    await click("Send code");
    await click("Change email");
    expect(emailField()).toBeTruthy();
  });
});

describe("the signed-in account's ways to sign in", () => {
  it("email only: the address without @, Link GitHub, and Remove email held as the only way in", async () => {
    const card = await show({ login: "dev@example.com", via: "studio", email: "dev@example.com", github: null });
    expect(card.textContent).toContain("Signed in as dev@example.com");
    expect(card.textContent).not.toContain("@dev@example.com");
    const remove = screen.getByRole("button", { name: "Remove email" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe(ACCOUNT_LAST_METHOD);
    expect(card.textContent).toContain(ACCOUNT_LAST_METHOD);
    expect(screen.getByRole("button", { name: "Link GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("GitHub only: Add email runs the same inline code entry against the account", async () => {
    m.startAccountEmail.mockResolvedValue({ ok: true, expiresInSeconds: 600 });
    m.verifyAccountEmail.mockResolvedValue({ userId: "u", login: "octocat", email: "cat@example.com", emailVerified: true, github: { login: "octocat" } });
    const card = await show({ login: "octocat", via: "studio", email: null, github: "octocat" });
    expect(card.textContent).toContain("Signed in as @octocat");
    expect((screen.getByRole("button", { name: "Unlink GitHub" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Add email");
    type(screen.getByLabelText("New email address"), "cat@example.com");
    await click("Send code");
    expect(m.startAccountEmail).toHaveBeenCalledWith("cat@example.com");
    expect(m.startEmailSignIn).not.toHaveBeenCalled();
    type(codeField(), "123456");
    await click("Add email");
    expect(m.verifyAccountEmail).toHaveBeenCalledWith("cat@example.com", "123456");
  });

  it("both linked: Unlink GitHub and Remove email are allowed, and an error shows inline", async () => {
    m.unlinkGitHub.mockRejectedValue(new ApiError(409, "Add an email before unlinking GitHub."));
    const card = await show({ login: "octocat", via: "studio", email: "cat@example.com", github: "octocat" });
    expect(card.textContent).not.toContain(ACCOUNT_LAST_METHOD);
    expect((screen.getByRole("button", { name: "Remove email" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Unlink GitHub");
    expect(m.unlinkGitHub).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Add an email before unlinking GitHub.");
  });

  it("Link GitHub starts the device flow against the account, not a new sign-in", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    m.startGitHubLink.mockResolvedValue({ state: "pending", url: "https://github.com/login/device", userCode: "LINK-0001", expiresAt: "2030-01-01T00:00:00Z" });
    await show({ login: "dev@example.com", via: "studio", email: "dev@example.com", github: null });
    await click("Link GitHub");
    expect(m.startGitHubLink).toHaveBeenCalled();
    expect(m.startSignIn).not.toHaveBeenCalled();
    expect(screen.getByText("LINK-0001")).toBeTruthy();
  });

  it("an agent from before email sign-in: no ways-to-sign-in list", async () => {
    const card = await show({ login: "dev", via: "studio" });
    expect(card.querySelector(".account-methods")).toBeNull();
  });
});
