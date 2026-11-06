// @vitest-environment jsdom
/**
 * /remote and /rc in the composer, and what a signed-out or free account sees
 * of remote control outside Settings, for each state: REMOTE_PLAN_OFFERED
 * off or on, signed out, a free or a paid account. The Upgrade action in the
 * reply opens the checkout in the system browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("@ue-mcp-studio/shared", async (original) => {
  const real = await original<typeof import("@ue-mcp-studio/shared")>();
  return {
    ...real,
    get REMOTE_PLAN_OFFERED() {
      return flag.on;
    },
  };
});
const sessions = [{ id: "s1", title: "First", status: "idle", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 }];
const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), saveDraft: vi.fn(), send: vi.fn(), remoteAvailable: vi.fn(), billingCheckout: vi.fn(), billingPortal: vi.fn(), remoteStatus: vi.fn(), setRemote: vi.fn(), pairRemote: vi.fn() }));
vi.mock("../api", () => {
  const pending = () => new Promise(() => {});
  // The chat asks for the session by sync; the plain detail these mocks give is read as it is.
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "sessionSync" ? (id: string) => m.session(id) : t[k] ?? pending) });
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { api, ApiError };
});
vi.mock("../state", () => ({ useDaemon: () => ({ events: [], health: null, streaming: true, error: null, refresh: () => {} }) }));
vi.mock("./SettingsHub", () => ({ SettingsHub: ({ section }: { section: string | null }) => <div>Settings view {section}</div> }));
vi.mock("./EditorBanner", () => ({ EditorBanner: () => null }));
vi.mock("./DialogBanner", () => ({ DialogBanner: () => null }));
vi.mock("./UpdateOverlay", () => ({ UpdateRunner: () => null }));
import { App } from "../App";
import { REMOTE_COMMAND_REPLY, STUDIO_PLAN_URL } from "@ue-mcp-studio/shared";
import { ApiError } from "../api";
import { CHECKOUT_OPENED, REMOTE_NOW_ON, REMOTE_SIGN_IN } from "./Upgrade";
import { CHECKOUT_POLL_MS, CHECKOUT_WATCH_MS, stopCheckoutWatch } from "./settings/remote-available";

const COMPOSER = "Ask for something in the editor, or drop files here";
const PAIRING = { url: "https://remote.test/pair#CODE", expiresAt: new Date(Date.now() + 600_000).toISOString(), svg: "<svg></svg>" };
const STATUS = { enabled: true, relay: "https://remote.test", state: "online", login: "dev", since: "2026-01-01T00:00:00Z" };
/** Remote control on and connected, and a pairing code to hand out. */
function online() {
  m.remoteStatus.mockResolvedValue(STATUS);
  m.pairRemote.mockResolvedValue(PAIRING);
}

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
  m.sessions.mockResolvedValue({ sessions });
  m.session.mockImplementation((id: string) => Promise.resolve({ ...sessions.find((s) => s.id === id), transcript: [], draft: "" }));
  m.saveDraft.mockResolvedValue(undefined);
  m.send.mockResolvedValue(undefined);
  window.location.hash = "#/chat/s1";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  flag.on = false;
  window.location.hash = "";
});

type Account = "signed-out" | "free" | "paid";

async function open(o: { flag: boolean; account: Account }) {
  flag.on = o.flag;
  m.remoteAvailable.mockResolvedValue({ available: o.account === "paid", signedIn: o.account !== "signed-out" });
  render(<App />);
  const box = (await screen.findByPlaceholderText(COMPOSER)) as HTMLTextAreaElement;
  await act(async () => undefined);
  return box;
}

async function type(box: HTMLTextAreaElement, text: string) {
  await act(async () => void fireEvent.change(box, { target: { value: text } }));
}

async function enter(box: HTMLTextAreaElement) {
  await act(async () => void fireEvent.keyDown(box, { key: "Enter" }));
}

const menu = () => [...document.querySelectorAll(".slash-menu .slash-name")].map((e) => e.textContent);

describe("/remote and /rc", () => {
  it("signed out, flag off: never listed, and /remote and /rc go out as ordinary messages", async () => {
    const box = await open({ flag: false, account: "signed-out" });
    expect(m.remoteAvailable).toHaveBeenCalledWith(false);
    await type(box, "/");
    expect(menu()).not.toContain("/remote");
    await type(box, "/rc ");
    await enter(box);
    expect(m.send).toHaveBeenCalledWith("s1", "/rc ", []);
    await type(box, "/remote");
    await enter(box);
    expect(m.send).toHaveBeenCalledWith("s1", "/remote", []);
    expect(document.querySelector(".local-reply")).toBeNull();
  });

  it("signed out, flag on: listed, and answered in the chat with the account sign-in, never by opening Settings", async () => {
    const box = await open({ flag: true, account: "signed-out" });
    await type(box, "/re");
    expect(menu()).toEqual(["/remote"]);
    await type(box, "/remote ");
    await enter(box);
    expect(m.send).not.toHaveBeenCalled();
    expect(screen.queryByText(/Settings view/)).toBeNull();
    expect(document.querySelector(".local-reply")!.textContent).toContain(REMOTE_SIGN_IN);
  });

  it.each([false, true])("paid account (flag %s): listed, also under /rc, and answered in the chat with a pairing code, no turn", async (on) => {
    online();
    const box = await open({ flag: on, account: "paid" });
    await type(box, "/");
    expect(menu()).toContain("/remote");
    await type(box, "/rc");
    expect(menu()).toEqual(["/remote"]);
    await type(box, "/rc ");
    await enter(box);
    expect(m.send).not.toHaveBeenCalled();
    expect(await screen.findByRole("img", { name: "Pairing QR code" })).toBeTruthy();
    // The code is in the session's chat; Settings is never opened for it.
    expect(screen.queryByText(/Settings view/)).toBeNull();
    expect(screen.getByRole("link", { name: PAIRING.url })).toBeTruthy();
    // Already on: not turned on again.
    expect(m.setRemote).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Manage paired devices in Settings" })));
    expect(screen.getByText("Settings view remote")).toBeTruthy();
  });

  it.each([false, true])("free account (flag %s): answered in the chat with the Upgrade action, no turn, listed only with the flag on", async (on) => {
    const box = await open({ flag: on, account: "free" });
    await type(box, "/re");
    expect(menu()).toEqual(on ? ["/remote"] : []);
    await type(box, "/remote");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(m.send).not.toHaveBeenCalled();
    const reply = document.querySelector(".local-reply")!;
    expect(reply.textContent).toContain(REMOTE_COMMAND_REPLY);
    expect(reply.querySelector(`a[href="${STUDIO_PLAN_URL}"]`)).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade to Remote" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "$5/month" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "$50/year" })).toBeTruthy();
    expect(reply.textContent).not.toMatch(/\bPro\b/);
    expect(box.value).toBe("");
    // /rc does the same.
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Dismiss" })));
    expect(screen.queryByText(REMOTE_COMMAND_REPLY, { exact: false })).toBeNull();
    await type(box, "/rc ");
    await enter(box);
    expect(screen.getByText(REMOTE_COMMAND_REPLY, { exact: false })).toBeTruthy();
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("the Upgrade action", () => {
  async function reply() {
    const box = await open({ flag: false, account: "free" });
    await type(box, "/remote ");
    await enter(box);
  }

  it("buys Remote at the chosen interval and opens the checkout in the system browser, never in the panel", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    m.billingCheckout.mockResolvedValue({ url: "https://checkout.stripe.test/c/1", provider: "stripe" });
    await reply();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "$50/year" })));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Upgrade to Remote" })));
    expect(m.billingCheckout).toHaveBeenCalledWith({ plan: "remote", interval: "year" });
    expect(opened).toHaveBeenCalledWith("https://checkout.stripe.test/c/1", "_blank", "noopener");
    expect(screen.getByText(CHECKOUT_OPENED)).toBeTruthy();
    expect(window.location.href).not.toContain("checkout.stripe.test");
  });

  it("opens the portal instead for an account that already has a subscription", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    m.billingCheckout.mockRejectedValue(new ApiError(409, "This account already has a subscription."));
    m.billingPortal.mockResolvedValue({ url: "https://billing.stripe.test/p/1" });
    await reply();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Upgrade to Remote" })));
    expect(m.billingCheckout).toHaveBeenCalledWith({ plan: "remote", interval: "month" });
    expect(opened).toHaveBeenCalledWith("https://billing.stripe.test/p/1", "_blank", "noopener");
  });

  it("says why when the checkout cannot be made, and opens nothing", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    m.billingCheckout.mockRejectedValue(new ApiError(503, "Plans cannot be bought yet."));
    await reply();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Upgrade to Remote" })));
    expect(screen.getByRole("alert").textContent).toBe("Plans cannot be bought yet.");
    expect(opened).not.toHaveBeenCalled();
  });

  it("asks the gateway afresh when Studio is focused again after checkout, so remote control appears without a restart", async () => {
    const box = await open({ flag: false, account: "free" });
    m.remoteAvailable.mockClear();
    m.remoteAvailable.mockResolvedValue({ available: true, signedIn: true });
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(m.remoteAvailable).toHaveBeenCalledWith(true);
    await type(box, "/");
    expect(menu()).toContain("/remote");
  });
});

describe("after checkout opens", () => {
  afterEach(() => {
    stopCheckoutWatch();
    vi.useRealTimers();
  });

  async function checkout() {
    online();
    vi.spyOn(window, "open").mockReturnValue(null);
    m.billingCheckout.mockResolvedValue({ url: "https://checkout.stripe.test/c/1", provider: "stripe" });
    const box = await open({ flag: false, account: "free" });
    await type(box, "/remote ");
    await enter(box);
    vi.useFakeTimers();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Upgrade to Remote" })));
    m.remoteAvailable.mockClear();
    return box;
  }

  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it("asks the gateway every few seconds without a focus event, and the reply turns into the confirmation once paid", async () => {
    await checkout();
    await tick(CHECKOUT_POLL_MS);
    expect(m.remoteAvailable).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Upgrade to Remote" })).toBeTruthy();
    m.remoteAvailable.mockResolvedValue({ available: true, signedIn: true });
    await tick(CHECKOUT_POLL_MS);
    expect(screen.getByText(REMOTE_NOW_ON)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade to Remote" })).toBeNull();
    // Paid: the watch stops.
    m.remoteAvailable.mockClear();
    await tick(CHECKOUT_POLL_MS * 5);
    expect(m.remoteAvailable).not.toHaveBeenCalled();
    // And the reply goes straight to the pairing code, in the chat.
    expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeTruthy();
    expect(screen.queryByText(/Settings view/)).toBeNull();
  });

  it("keeps watching after the reply is dismissed, and gives up after the watch window", async () => {
    await checkout();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Dismiss" })));
    await tick(CHECKOUT_POLL_MS);
    expect(m.remoteAvailable).toHaveBeenCalledWith(true);
    await tick(CHECKOUT_WATCH_MS + CHECKOUT_POLL_MS);
    m.remoteAvailable.mockClear();
    await tick(CHECKOUT_POLL_MS * 5);
    expect(m.remoteAvailable).not.toHaveBeenCalled();
  });

  it("asks again when the panel becomes visible", async () => {
    await open({ flag: false, account: "free" });
    m.remoteAvailable.mockClear();
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(m.remoteAvailable).toHaveBeenCalledWith(true);
  });
});

describe("outside Settings, before /remote is typed", () => {
  it.each([
    [false, "signed-out"],
    [false, "free"],
    [true, "signed-out"],
    [true, "free"],
  ] as const)("flag %s, %s: nothing of remote control, plans or upgrading", async (on, account) => {
    await open({ flag: on, account });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/remote/i);
    expect(text).not.toMatch(/Remote plan|Pro plan|Upgrade|plan/i);
    expect(document.querySelector(`a[href="${STUDIO_PLAN_URL}"]`)).toBeNull();
    expect(document.querySelector(".remote-plan-note, .local-reply, .upgrade, [aria-label*='emote' i], [title*='emote' i]")).toBeNull();
  });
});
