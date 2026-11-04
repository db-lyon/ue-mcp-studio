/**
 * The feedback sheet, an update the computer runs followed from the phone,
 * the version notice and the refused screen.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { REMOTE_UPDATES } from "@ue-mcp-studio/client-core";
import { Linking } from "react-native";
import { FeedbackSheet } from "../src/screens/feedback/FeedbackSheet";
import { UpdateNotices } from "../src/screens/updates/UpdateNotices";
import { setUpdateRun } from "../src/screens/updates/run";
import { RefusedScreen, VersionNoticeLine } from "../src/screens/updates/VersionNotice";
import { renderArea, settled } from "./area-b";

const fill = () => {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "The model picker forgets my effort" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "I set effort to high, opened another session, and it was back to medium." } });
};

describe("Feedback", () => {
  it("sends only once there is a title and a description, with the environment", async () => {
    const { writes } = renderArea("feedback-remote-filed", <FeedbackSheet onClose={vi.fn()} />);
    await settled();
    expect(screen.getByLabelText("Send").getAttribute("aria-disabled")).toBe("true");
    fill();
    fireEvent.click(screen.getByText("What gets added"));
    expect(screen.getByText(/Unreal Engine 5.7/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Send"));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ path: "/v1/ext/studio/feedback", json: { kind: "problem", title: "The model picker forgets my effort", description: "I set effort to high, opened another session, and it was back to medium.", includeEnvironment: true } }));
    expect(screen.getByText("issue #321")).toBeTruthy();
  });

  it("switches to an idea's wording, and leaves the environment out when unticked", async () => {
    const { writes } = renderArea("feedback-remote-filed", <FeedbackSheet onClose={vi.fn()} />);
    await settled();
    fireEvent.click(screen.getByLabelText("Suggest an idea"));
    expect(screen.getByPlaceholderText("The idea, in a line")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fill();
    fireEvent.click(screen.getByLabelText("Send"));
    await settled();
    expect(writes()[0]?.json).toMatchObject({ kind: "idea", includeEnvironment: false });
  });

  it("opens GitHub when the report could not be filed, and says why a send failed", async () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(true);
    let v = renderArea("feedback-remote-link", <FeedbackSheet onClose={vi.fn()} />);
    await settled();
    fill();
    fireEvent.click(screen.getByLabelText("Send"));
    await settled();
    expect(open).toHaveBeenCalledWith("https://github.com/db-lyon/ue-mcp-studio/issues/new");
    expect(screen.getByText(/GitHub did not answer\./)).toBeTruthy();
    v.unmount();
    v = renderArea("feedback-remote-error", <FeedbackSheet onClose={vi.fn()} />);
    await settled();
    fill();
    fireEvent.click(screen.getByLabelText("Send"));
    await settled();
    expect(screen.getByText("The feedback service could not be reached.")).toBeTruthy();
    open.mockRestore();
  });
});

describe("An update the computer runs", () => {
  it("shows the banner while a step waits for the turn, and the steps while it runs", async () => {
    const { emit } = renderArea("settings-list", <UpdateNotices />);
    await settled();
    await emit("studio.update.run", { run: { steps: [{ key: "ueMcp", state: "done" }, { key: "studio", state: "deferred" }], target: "1.4.11", at: Date.now() } });
    expect(screen.getByText(/restarts when the current turn finishes\./)).toBeTruthy();
    await emit("studio.update.run", { run: { steps: [{ key: "ueMcp", state: "done" }, { key: "plugin", state: "active" }], target: "1.4.11", at: Date.now(), detail: "Closing the editor" } });
    expect(screen.getByText("Updating")).toBeTruthy();
    expect(screen.getByText("Closing the editor")).toBeTruthy();
    await emit("studio.update.progress", { message: "Copying the plugin" });
    expect(screen.getByText("Copying the plugin")).toBeTruthy();
    act(() => setUpdateRun(null));
  });

  it("says why it stopped, and what it installed", async () => {
    const { emit } = renderArea("settings-list", <UpdateNotices />);
    await settled();
    await emit("studio.update.run", { run: { steps: [{ key: "plugin", state: "failed" }], target: null, at: Date.now(), error: "It did not install." } });
    expect(screen.getByText("Update stopped")).toBeTruthy();
    expect(screen.getByText("It did not install.")).toBeTruthy();
    await emit("studio.update.run", { run: { steps: [{ key: "studio", state: "done" }], target: null, at: Date.now(), summary: "Studio 0.1.25." } });
    expect(screen.getByText("Updated")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Done"));
    expect(screen.queryByText("Updated")).toBeNull();
  });

  it("asks the computer to restart now, and shows its refusal", async () => {
    const { emit, writes } = renderArea("settings-list", <UpdateNotices />);
    await settled();
    await emit("studio.update.run", { run: { steps: [{ key: "studio", state: "deferred" }], target: null, at: Date.now() } });
    fireEvent.click(screen.getByLabelText("Restart now"));
    fireEvent.click(screen.getByLabelText("Restart and stop the turn"));
    await settled();
    expect(writes()).toContainEqual(expect.objectContaining({ path: "/v1/ext/studio/updates/deferred/now", status: 403 }));
    expect(screen.getByText(/Not available remotely\./)).toBeTruthy();
    act(() => setUpdateRun(null));
  });
});

describe("Version notices", () => {
  it("says another project installed a newer Studio, with no button", () => {
    renderArea("version-notice", <VersionNoticeLine notice={{ installed: "0.1.25", current: "0.1.23" }} error={null} />);
    expect(screen.getByText(/Studio 0.1.25 was installed by another project\. This project uses 0.1.23\./)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says what ue-mcp Studio needs, and that the update runs on the computer", () => {
    renderArea("refused-by-studio", <RefusedScreen refusal={{ needs: "1.4.11-beta.6", have: "1.4.11-beta.4" }} />);
    expect(screen.getByText("Studio needs ue-mcp 1.4.11-beta.6. You have 1.4.11-beta.4.")).toBeTruthy();
    expect(screen.getByText(REMOTE_UPDATES)).toBeTruthy();
  });
});
