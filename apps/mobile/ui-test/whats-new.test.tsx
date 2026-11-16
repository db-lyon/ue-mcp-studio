/** What's new on the phone: the accordions, the notes, and a part whose notes could not be read. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Linking } from "react-native";
import { WhatsNewSheet } from "../src/screens/updates/WhatsNewSheet";
import { renderArea, settled } from "./area-b";

describe("What's new", () => {
  it("shows a part's notes under each version, marks what is available, and hides an empty part", async () => {
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("0.1.24-beta.24 to 0.1.24-beta.26, 0.1.24-beta.27 available")).toBeTruthy();
    expect(screen.getByText("0.1.24-beta.27")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText(/A long reply no longer jumps/)).toBeTruthy();
    expect(screen.getByText("No notes for this release.")).toBeTruthy();
    expect(screen.queryByText("Bridge plugin (UE_MCP_Bridge)")).toBeNull();
  });

  it("says when a part's notes could not be read, with Retry and the release page", async () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    fireEvent.click(screen.getByText("Editor plugin (UE_MCP_Studio)"));
    expect(screen.getByText("Could not load the release notes: GitHub is limiting requests right now.")).toBeTruthy();
    expect(screen.getByLabelText("Retry")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Release page").at(-1)!);
    expect(open).toHaveBeenCalledWith("https://github.com/db-lyon/ue-mcp-studio-plugin/releases");
    open.mockRestore();
  });
});
