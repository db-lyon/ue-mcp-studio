// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ feedbackEnvironment: vi.fn(), sendFeedback: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { FeedbackDialog } from "./Feedback";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const fill = () => {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changes panel is blank" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Clicking the Git chip opens an empty panel." } });
};

describe("feedback", () => {
  it("sends a problem with the environment and shows the issue it became", async () => {
    m.feedbackEnvironment.mockResolvedValue({ body: "### Environment\n- Studio 0.1.0-beta.27" });
    m.sendFeedback.mockResolvedValue({ filed: true, url: "https://github.com/db-lyon/ue-mcp-studio/issues/9", number: 9 });
    render(<FeedbackDialog onClose={() => {}} />);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fill();
    await waitFor(() => expect(screen.getByText(/Studio 0.1.0-beta.27/)).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(m.sendFeedback).toHaveBeenCalledWith({ kind: "problem", title: "Changes panel is blank", description: "Clicking the Git chip opens an empty panel.", includeEnvironment: true });
    await waitFor(() => expect(screen.getByText("issue #9")).toBeTruthy());
  });

  it("sends with a title alone, and on a send error offers the report on GitHub, filled in", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    m.feedbackEnvironment.mockResolvedValue({ body: "### Environment\n- Studio 0.1.0\n\n_Filed from the Studio panel._" });
    m.sendFeedback.mockRejectedValue(new Error("Studio is not answering."));
    render(<FeedbackDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Odd" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(screen.getByText(/Studio 0.1.0/)).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(screen.getByText("Studio is not answering.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
    const url = new URL(open.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/db-lyon/ue-mcp-studio/issues/new");
    expect(url.searchParams.get("title")).toBe("Odd");
    expect(url.searchParams.get("labels")).toBe("bug,from-studio");
    expect(url.searchParams.get("body")).toContain("- Studio 0.1.0");
  });

  it("opens the report on GitHub, filled in, when it could not be filed", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    m.feedbackEnvironment.mockResolvedValue({ body: "" });
    m.sendFeedback.mockResolvedValue({ filed: false, reason: "The feedback service could not be reached.", link: "https://github.com/db-lyon/ue-mcp-studio/issues/new?title=x" });
    render(<FeedbackDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Suggest an idea" }));
    fill();
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(m.sendFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: "idea", includeEnvironment: false }));
    await waitFor(() => expect(screen.getByText(/could not be reached/)).toBeTruthy());
    expect(open).toHaveBeenCalledWith("https://github.com/db-lyon/ue-mcp-studio/issues/new?title=x", "_blank", "noopener");
  });
});
