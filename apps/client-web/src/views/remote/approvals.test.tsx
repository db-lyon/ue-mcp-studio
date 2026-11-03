// @vitest-environment jsdom
/**
 * A browser that scanned a pairing code waits for the owner: the request in the
 * /remote reply and as a Studio-wide banner (never both), Allow and Deny, the
 * notice once one is paired, and the paired browsers with Remove in the reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
import { publishEvent } from "../../extensions/events";
import { RemoteApprovalBanner } from "./approvals";
import { RemoteChatCard } from "./RemoteChatCard";

const RELAY = "https://remote.test";
const online = { enabled: true, relay: RELAY, state: "online", login: "dev", since: "2026-01-01T00:00:00Z" };
const waiting = { id: "a1", label: "iPhone (Safari)", code: "123456", expiresAt: new Date(Date.now() + 120_000).toISOString(), project: "Vale" };
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  m.remoteStatus.mockResolvedValue(online);
  m.pairRemote.mockResolvedValue({ url: `${RELAY}/pair#C`, expiresAt: new Date(Date.now() + 600_000).toISOString(), svg: "<svg></svg>" });
  m.remoteApprovals.mockResolvedValue({ approvals: [] });
  m.remoteBrowsers.mockResolvedValue({ browsers: [] });
  m.decideRemoteApproval.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("allowing a browser", () => {
  it("the banner names the browser and the project and shows the code; Allow allows it", async () => {
    m.remoteApprovals.mockResolvedValueOnce({ approvals: [waiting] }).mockResolvedValue({ approvals: [] });
    render(<RemoteApprovalBanner />);
    await flush();
    const prompt = screen.getByRole("alertdialog", { name: "iPhone (Safari) wants to control Vale" });
    expect(prompt.textContent).toContain("123 456");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await flush();
    expect(m.decideRemoteApproval).toHaveBeenCalledWith("a1", true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Deny denies it", async () => {
    m.remoteApprovals.mockResolvedValueOnce({ approvals: [waiting] }).mockResolvedValue({ approvals: [] });
    render(<RemoteApprovalBanner />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await flush();
    expect(m.decideRemoteApproval).toHaveBeenCalledWith("a1", false);
  });

  it("a request arriving later shows when the agent announces it", async () => {
    render(<RemoteApprovalBanner />);
    await flush();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    m.remoteApprovals.mockResolvedValue({ approvals: [waiting] });
    act(() => publishEvent({ type: "studio.remote.approval", data: {} } as never));
    await flush();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("says so once a browser is paired, and Dismiss hides it", async () => {
    render(<RemoteApprovalBanner />);
    await flush();
    act(() => publishEvent({ type: "studio.remote.paired", data: { label: "Android (Chrome)" } } as never));
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Android (Chrome) is paired");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("in the /remote reply: the request shows there and not again in the banner", async () => {
    m.remoteApprovals.mockResolvedValue({ approvals: [waiting] });
    render(
      <>
        <RemoteApprovalBanner />
        <RemoteChatCard />
      </>,
    );
    await flush();
    await flush();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alertdialog").closest(".remote-chat-card")).not.toBeNull();
  });

  it("the /remote reply lists paired browsers, and Remove removes one", async () => {
    m.remoteBrowsers.mockResolvedValue({ browsers: [{ id: "p1", label: "Android", addedAt: "2026-11-03T19:15:57.234Z" }] });
    m.revokeRemoteBrowser.mockResolvedValue(undefined);
    render(<RemoteChatCard />);
    await flush();
    await flush();
    expect(screen.getByText("Android")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await flush();
    expect(m.revokeRemoteBrowser).toHaveBeenCalledWith("p1");
    expect(screen.queryByText("Android")).toBeNull();
  });
});
