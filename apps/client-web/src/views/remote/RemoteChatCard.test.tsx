// @vitest-environment jsdom
/**
 * The /remote reply on a paid plan: remote control turned on when it was off,
 * a wait for the relay, the pairing code, its expiry and a new one, and the
 * relay's error said plainly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { REMOTE_NO_PLAN } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  remoteStatus: vi.fn(),
  setRemote: vi.fn(),
  pairRemote: vi.fn(),
  remoteApprovals: vi.fn(),
  decideRemoteApproval: vi.fn(),
  remoteBrowsers: vi.fn(),
  revokeRemoteBrowser: vi.fn(),
}));
vi.mock("../../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { api: m, ApiError };
});
import { ApiError } from "../../api";
import { CONNECT_POLL_MS, CONNECT_WAIT_MS, RemoteChatCard } from "./RemoteChatCard";

const RELAY = "https://remote.test";
const off = { enabled: false, relay: RELAY, state: "off" };
const connecting = { enabled: true, relay: RELAY, state: "connecting" };
const online = { enabled: true, relay: RELAY, state: "online", login: "dev", since: "2026-01-01T00:00:00Z" };
const code = (ms: number, n = 1) => ({ url: `${RELAY}/pair#CODE${n}`, expiresAt: new Date(Date.now() + ms).toISOString(), svg: `<svg data-n="${n}"></svg>` });
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  m.remoteApprovals.mockResolvedValue({ approvals: [] });
  m.remoteBrowsers.mockResolvedValue({ browsers: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the /remote pairing card", () => {
  it("turns remote control on, says Connecting until the relay answers, then shows the code", async () => {
    vi.useFakeTimers();
    m.remoteStatus.mockResolvedValueOnce(off).mockResolvedValueOnce(connecting).mockResolvedValue(online);
    m.setRemote.mockResolvedValue(connecting);
    m.pairRemote.mockResolvedValue(code(600_000));
    render(<RemoteChatCard />);
    await tick(0);
    expect(m.setRemote).toHaveBeenCalledWith(true);
    expect(screen.getByRole("status").textContent).toContain("Connecting");
    expect(m.pairRemote).not.toHaveBeenCalled();
    await tick(CONNECT_POLL_MS * 2);
    expect(m.pairRemote).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Pairing QR code" }).innerHTML).toContain('data-n="1"');
    expect(screen.getByRole("link", { name: `${RELAY}/pair#CODE1` })).toBeTruthy();
    expect(screen.getByText(/^Works once, for 9:5\d more\.$/)).toBeTruthy();
  });

  it("offers a new code when this one expires, and shows the new one", async () => {
    vi.useFakeTimers();
    m.remoteStatus.mockResolvedValue(online);
    m.pairRemote.mockResolvedValueOnce(code(5_000, 1)).mockResolvedValueOnce(code(600_000, 2));
    render(<RemoteChatCard />);
    await tick(0);
    expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeTruthy();
    await tick(6_000);
    expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
    expect(screen.getByText("This code has expired.")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "New code" })));
    await tick(0);
    expect(screen.getByRole("img", { name: "Pairing QR code" }).innerHTML).toContain('data-n="2"');
  });

  it("says the relay's error plainly, and Retry starts again", async () => {
    m.remoteStatus.mockResolvedValueOnce({ enabled: true, relay: RELAY, state: "error", reason: "The relay refused the connection (HTTP 502)." }).mockResolvedValue(online);
    m.pairRemote.mockResolvedValue(code(600_000));
    render(<RemoteChatCard />);
    expect((await screen.findByRole("alert")).textContent).toContain("The relay refused the connection (HTTP 502).");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(await screen.findByRole("img", { name: "Pairing QR code" })).toBeTruthy();
  });

  it("gives up after the wait with the relay named, and reads a refused pairing as the plan", async () => {
    vi.useFakeTimers();
    m.remoteStatus.mockResolvedValue(connecting);
    render(<RemoteChatCard />);
    await tick(CONNECT_WAIT_MS + CONNECT_POLL_MS * 2);
    expect(screen.getByRole("alert").textContent).toContain(`did not connect to ${RELAY}`);
    cleanup();
    vi.useRealTimers();
    m.remoteStatus.mockResolvedValue(online);
    m.pairRemote.mockRejectedValue(new ApiError(403, "no"));
    render(<RemoteChatCard />);
    expect((await screen.findByRole("alert")).textContent).toContain(REMOTE_NO_PLAN);
  });

  it("links to Settings for managing paired browsers", async () => {
    m.remoteStatus.mockResolvedValue(online);
    m.pairRemote.mockResolvedValue(code(600_000));
    const open = vi.fn();
    render(<RemoteChatCard onSettings={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage paired browsers in Settings" }));
    expect(open).toHaveBeenCalled();
  });
});
