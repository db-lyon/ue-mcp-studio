/** What's new on the phone: the accordions, the notes with their folds, and a part whose notes could not be read. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Linking } from "react-native";
import { WhatsNewSheet } from "../src/screens/updates/WhatsNewSheet";
import { renderArea, settled } from "./area-b";

describe("What's new", () => {
  it("shows only the releases newer than installed under each version, and hides a part with nothing newer", async () => {
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("0.1.24-beta.24 to 0.1.24-beta.27")).toBeTruthy();
    expect(screen.getByText("0.1.24-beta.27")).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();
    expect(screen.getByText("No notes for this release.")).toBeTruthy();
    expect(screen.queryByText("Bridge plugin (UE_MCP_Bridge)")).toBeNull();
  });

  it("drops the heading restating a version, draws headings plainly, and folds <details> with its markdown inside", async () => {
    renderArea("settings-whats-new", <WhatsNewSheet onClose={vi.fn()} />);
    await settled();
    // "## v0.1.24-beta.27" restates the version under its own heading: only the version row says it.
    expect(screen.getAllByText("0.1.24-beta.27")).toHaveLength(1);
    expect(screen.getByText("Features")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/<\/?(details|summary|b|script)>|window\.hacked/);
    // The fold is closed until tapped, then shows its list.
    expect(screen.queryByText(/reports a modal's pickers/)).toBeNull();
    fireEvent.click(screen.getByText("Editor dialogs"));
    expect(screen.getByText(/reports a modal's pickers/)).toBeTruthy();
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
