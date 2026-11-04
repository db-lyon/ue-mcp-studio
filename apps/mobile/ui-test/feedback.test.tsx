/** The feedback sheet: the report, its environment, and each answer. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Linking } from "react-native";
import { FeedbackSheet } from "../src/screens/feedback/FeedbackSheet";
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
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
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
