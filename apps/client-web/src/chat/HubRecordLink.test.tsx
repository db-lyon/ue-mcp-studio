// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { hubRecordIndex, type HubRoute } from "@ue-mcp-studio/client-core";

vi.mock("../api", () => {
  class ApiError extends Error {}
  return { ApiError, api: { openAsset: vi.fn(async (path: string) => ({ path, alreadyOpen: false })), resolveAssets: vi.fn(), reportAssetMiss: vi.fn(async () => undefined) } };
});
import { api } from "../api";
import { HubRecordsContext, type HubRecords } from "./HubRecordLink";
import { ReplyMarkdown } from "./ReplyMarkdown";
import { hubFixture } from "../views/hub/test-data";

afterEach(() => {
  cleanup();
  vi.mocked(api.openAsset).mockClear();
});

function withHub(ui: React.ReactNode, records: Partial<HubRecords> = {}) {
  const open = vi.fn<(r: HubRoute) => void>();
  render(<HubRecordsContext.Provider value={{ index: hubRecordIndex(hubFixture()), open, ...records }}>{ui}</HubRecordsContext.Provider>);
  return open;
}

describe("links to Playtest Hub records", () => {
  it("opens a playtest's script link from a reply in the hub, not the editor", () => {
    const open = withHub(<ReplyMarkdown text="See [Jump](/Game/Tests/Jump.Jump)." />);
    const link = screen.getByText("Jump").closest("a")!;
    expect(link.getAttribute("href")).toBe("#/playtests/checks/" + encodeURIComponent("script:/Game/Tests/Jump"));
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith({ screen: "check", checkId: "script:/Game/Tests/Jump" });
    expect(api.openAsset).not.toHaveBeenCalled();
  });

  it("opens goal, milestone and run addresses and known ids from a reply", () => {
    const open = withHub(<ReplyMarkdown text="[Alpha](#/playtests/goals/alpha), [the run](#/playtests/runs/run-jump-2) and [Movement](movement)." />);
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByText("the run"));
    fireEvent.click(screen.getByText("Movement"));
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      { screen: "goal", goalId: "alpha" },
      { screen: "run", runId: "run-jump-2" },
      { screen: "goal", goalId: "movement" },
    ]);
  });

  it("keeps opening other assets in the editor", async () => {
    const open = withHub(<ReplyMarkdown text="[BP_Door](/Game/Props/BP_Door.BP_Door)" />);
    fireEvent.click(screen.getByRole("button", { name: "BP_Door" }));
    expect(open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(api.openAsset).toHaveBeenCalledWith("/Game/Props/BP_Door.BP_Door"));
  });

  it("keeps opening a playtest's script in the editor while the hub is off", async () => {
    render(<ReplyMarkdown text="[Jump](/Game/Tests/Jump.Jump) and [Alpha](#/playtests/goals/alpha)" />);
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    await vi.waitFor(() => expect(api.openAsset).toHaveBeenCalledWith("/Game/Tests/Jump.Jump"));
    // A hub address with the hub off is its text.
    expect(screen.getByText(/Alpha/).querySelector("a")).toBeNull();
  });
});
