import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { playtestRecordIndex, type HubRoute } from "@ue-mcp-studio/client-core";
import { HubRecordsContext } from "../src/chat/HubRecordLink";
import { ReplyMarkdown } from "../src/chat/ReplyMarkdown";
import { renderInProject, settle } from "./helpers";

const index = playtestRecordIndex([{ script: "/Game/Tests/PT_DoorOpens" }]);

function withHub(text: string, on = true) {
  const open = vi.fn<(r: HubRoute) => void>();
  const view = renderInProject(<HubRecordsContext.Provider value={on ? { index, open } : null}><ReplyMarkdown text={text} /></HubRecordsContext.Provider>);
  return { open, ...view };
}

describe("links to Playtest Hub records on the phone", () => {
  it("opens a playtest's script link at its card on the Playtests page, not in the editor", () => {
    const { open, api } = withHub("See [PT_DoorOpens](/Game/Tests/PT_DoorOpens.PT_DoorOpens).");
    fireEvent.click(screen.getByRole("link"));
    expect(open).toHaveBeenCalledWith({ screen: "check", checkId: "script:/Game/Tests/PT_DoorOpens" });
    expect(api.openAsset).not.toHaveBeenCalled();
  });

  it("opens a hub address on the Playtests page", () => {
    const { open } = withHub("[Alpha](#/playtests/goals/alpha)");
    fireEvent.click(screen.getByText("Alpha"));
    expect(open).toHaveBeenCalledWith({ screen: "goal", goalId: "alpha" });
  });

  it("keeps opening other assets, and playtests while the hub is off, in the editor", async () => {
    const { open, api } = withHub("[BP_Door](/Game/Props/BP_Door.BP_Door)");
    api.openAsset.mockResolvedValue({});
    fireEvent.click(screen.getByLabelText("/Game/Props/BP_Door.BP_Door"));
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(api.openAsset).toHaveBeenCalledWith("/Game/Props/BP_Door.BP_Door");
  });

  it("opens a playtest's script in the editor while the hub is off", async () => {
    const { api } = withHub("[PT_DoorOpens](/Game/Tests/PT_DoorOpens.PT_DoorOpens)", false);
    api.openAsset.mockResolvedValue({});
    fireEvent.click(screen.getByLabelText("/Game/Tests/PT_DoorOpens.PT_DoorOpens"));
    await settle();
    expect(api.openAsset).toHaveBeenCalledWith("/Game/Tests/PT_DoorOpens.PT_DoorOpens");
  });
});
