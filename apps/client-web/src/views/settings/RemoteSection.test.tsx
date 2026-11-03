// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  remoteStatus: vi.fn(),
  setRemote: vi.fn(),
  pairRemote: vi.fn(),
  remoteBrowsers: vi.fn(),
  revokeRemoteBrowser: vi.fn(),
}));
const e = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("../../api", () => ({ api: m, ApiError: e.ApiError }));
import { NO_PLAN_TEXT, RemoteSection } from "./RemoteSection";

const RELAY = "https://remote.ue-mcp.com";
const OFF = { enabled: false, relay: RELAY, state: "off" };
const ONLINE = { enabled: true, relay: RELAY, state: "online", login: "dev", since: "2026-11-03T00:00:00Z" };
const PHONE = { id: "p1", label: "Android", addedAt: "2026-11-01T00:00:00Z" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function show(status: unknown, browsers: unknown[] = []) {
  m.remoteStatus.mockResolvedValue(status);
  m.remoteBrowsers.mockResolvedValue({ browsers });
  await act(async () => void render(<RemoteSection />));
}

describe("Settings > Remote control", () => {
  it("is off with nothing paired, and New code waits for a connection", async () => {
    await show(OFF);
    expect(screen.getByRole("switch", { name: "Remote control" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByText("No browsers paired.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "New code" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns on and shows the connection the agent reports", async () => {
    await show(OFF);
    m.setRemote.mockResolvedValue({ enabled: true, relay: RELAY, state: "connecting", attempt: 0 });
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Remote control" })));
    expect(m.setRemote).toHaveBeenCalledWith(true);
    expect(screen.getByText("Connecting")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Remote control" }).getAttribute("aria-checked")).toBe("true");
  });

  it("when online, makes a pairing code: the QR code and its link", async () => {
    await show(ONLINE);
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText(`Signed in as dev, through ${RELAY}`)).toBeTruthy();
    m.pairRemote.mockResolvedValue({ url: `${RELAY}/pair#code.key.secret`, svg: '<svg viewBox="0 0 10 10"><path d="M0 0h1v1H0z"/></svg>' });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "New code" })));
    expect(screen.getByRole("img", { name: "Pairing QR code" }).querySelector("svg")).toBeTruthy();
    const link = screen.getByRole("link", { name: `${RELAY}/pair#code.key.secret` }) as HTMLAnchorElement;
    expect(link.href).toBe(`${RELAY}/pair#code.key.secret`);
    expect(link.rel).toBe("noreferrer");
  });

  it("lists paired browsers and removes one", async () => {
    await show(ONLINE, [PHONE, { id: "p2", label: "iOS", addedAt: "2026-11-02T00:00:00Z" }]);
    expect(screen.getByText("Android")).toBeTruthy();
    m.revokeRemoteBrowser.mockResolvedValue(undefined);
    await act(async () => void fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!));
    expect(m.revokeRemoteBrowser).toHaveBeenCalledWith("p1");
    expect(screen.queryByText("Android")).toBeNull();
    expect(screen.getByText("iOS")).toBeTruthy();
  });

  it("says plainly when the account's plan does not include remote control", async () => {
    await show({ enabled: true, relay: RELAY, state: "error", reason: NO_PLAN_TEXT, code: "no-plan" });
    expect(screen.getByRole("alert").textContent).toBe(NO_PLAN_TEXT);
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect((screen.getByRole("button", { name: "New code" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the same when the relay refuses a pairing code with 403", async () => {
    await show(ONLINE);
    m.pairRemote.mockRejectedValue(new e.ApiError(403, "Forbidden"));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "New code" })));
    expect(screen.getByRole("alert").textContent).toContain(NO_PLAN_TEXT);
  });

  it("shows another failure with Retry", async () => {
    m.remoteStatus.mockRejectedValueOnce(new e.ApiError(500, "disk full"));
    m.remoteBrowsers.mockResolvedValue({ browsers: [] });
    await act(async () => void render(<RemoteSection />));
    expect(screen.getByRole("alert").textContent).toContain("disk full");
    m.remoteStatus.mockResolvedValue(OFF);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Off")).toBeTruthy();
  });

  it("tells Settings when the agent no longer offers it (404), and shows no error", async () => {
    m.remoteStatus.mockRejectedValue(new e.ApiError(404, "Not found."));
    m.remoteBrowsers.mockRejectedValue(new e.ApiError(404, "Not found."));
    const onUnavailable = vi.fn();
    await act(async () => void render(<RemoteSection onUnavailable={onUnavailable} />));
    expect(onUnavailable).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("words no-plan the way the relay does", () => {
    expect(NO_PLAN_TEXT).toBe("Remote control needs a Pro or Studio plan on this account.");
  });

  it("from a paired browser, which is refused these routes, says they are set up on the computer", async () => {
    m.remoteStatus.mockRejectedValue(new e.ApiError(403, "Not available remotely."));
    m.remoteBrowsers.mockRejectedValue(new e.ApiError(403, "Not available remotely."));
    await act(async () => void render(<RemoteSection />));
    expect(screen.getByRole("status").textContent).toMatch(/from the computer running the project/);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("rereads the connection while it is open, and stops when it closes", async () => {
    vi.useFakeTimers();
    try {
      m.remoteStatus.mockResolvedValue(OFF);
      m.remoteBrowsers.mockResolvedValue({ browsers: [] });
      const r = render(<RemoteSection />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      m.remoteStatus.mockResolvedValue(ONLINE);
      await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
      expect(screen.getByText("Online")).toBeTruthy();
      const calls = m.remoteStatus.mock.calls.length;
      r.unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(m.remoteStatus.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
