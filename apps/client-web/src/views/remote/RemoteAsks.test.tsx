// @vitest-environment jsdom
/** What a paired device asked the computer for, shown on the computer with the way to do it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ remoteAsks: vi.fn(), clearRemoteAsk: vi.fn(), remoteApprovals: vi.fn() }));
vi.mock("../../api", () => ({ api: m }));
const handlers = vi.hoisted(() => ({ list: [] as Array<(e: { type: string; data: unknown }) => void> }));
vi.mock("../../extensions/events", () => ({ subscribeEvent: (f: (e: { type: string; data: unknown }) => void) => (handlers.list.push(f), () => void 0) }));
vi.mock("../../connection", () => ({ onRemotePage: () => false }));
import { RemoteApprovalBanner } from "./approvals";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers.list.length = 0;
});

describe("a paired device's ask, on the computer", () => {
  it("shows what was asked, Open goes to the screen that does it, and the ask is cleared", async () => {
    m.remoteApprovals.mockResolvedValue({ approvals: [] });
    m.remoteAsks.mockResolvedValue({ asks: [] });
    m.clearRemoteAsk.mockResolvedValue(undefined);
    const open = vi.fn();
    render(<RemoteApprovalBanner onOpenAsk={open} />);
    await act(async () => void handlers.list.forEach((f) => f({ type: "studio.remote.ask", data: { what: "update", at: 1, project: "Door" } })));
    expect(screen.getByText("A paired device asks you to update Door.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Updates" }));
    expect(open).toHaveBeenCalledWith({ label: "Open Updates", tab: "Settings", section: "general" });
    expect(m.clearRemoteAsk).toHaveBeenCalledWith("update");
    expect(screen.queryByText(/asks you to update/)).toBeNull();
  });

  it("is read when Studio opens, so an ask sent while it was closed is still there", async () => {
    m.remoteApprovals.mockResolvedValue({ approvals: [] });
    m.remoteAsks.mockResolvedValue({ asks: [{ what: "plugins", at: 1, project: "Door" }] });
    render(<RemoteApprovalBanner />);
    expect(await screen.findByText("A paired device asks you to change the plugins of Door.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(m.clearRemoteAsk).toHaveBeenCalledWith("plugins");
  });
});
