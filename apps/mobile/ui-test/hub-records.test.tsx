import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { HubRoute } from "@ue-mcp-studio/client-core";
import { HubRecordsContext } from "../src/chat/HubRecordLink";
import { ReplyMarkdown } from "../src/chat/ReplyMarkdown";
import { renderInProject, settle } from "./helpers";

function withHub(text: string, on = true) {
  const open = vi.fn<(r: HubRoute) => void>();
  const view = renderInProject(<HubRecordsContext.Provider value={on ? { open } : null}><ReplyMarkdown text={text} /></HubRecordsContext.Provider>);
  return { open, ...view };
}

describe("links to Playtest Hub screens on the phone", () => {
  it("opens a hub address where a client provides the hub", () => {
    const { open } = withHub("[Arena](#/playtests/arrangements/arena)");
    fireEvent.click(screen.getByText("Arena"));
    expect(open).toHaveBeenCalledWith({ screen: "arrangement", id: "arena" });
  });

  it("draws a hub address as its text where there is no hub, as on the phone", () => {
    withHub("[Arena](#/playtests/arrangements/arena)", false);
    expect(screen.getByText("Arena")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps opening assets in the editor", async () => {
    const { open, api } = withHub("[BP_Door](/Game/Props/BP_Door.BP_Door)");
    api.openAsset.mockResolvedValue({});
    fireEvent.click(screen.getByLabelText("/Game/Props/BP_Door.BP_Door"));
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(api.openAsset).toHaveBeenCalledWith("/Game/Props/BP_Door.BP_Door");
  });
});
