// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ answerForm: vi.fn(async () => {}) }));
vi.mock("../api", () => ({ api: m }));
import { FormCard } from "./Forms";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const form = {
  id: "f1", sessionId: "s1", call: "feedback(submit)", at: "", message: "File this report?",
  fields: { revisions: { type: "string" as const, title: "Changes" }, destination: { type: "string" as const, title: "Where", enum: ["ue-mcp", "plugin"] } },
  required: [],
};

describe("a form card", () => {
  it("sends what the user filled in", () => {
    render(<FormCard form={form} />);
    fireEvent.change(screen.getByLabelText(/Changes/), { target: { value: "shorter title" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(m.answerForm).toHaveBeenCalledWith("f1", { action: "accept", content: { revisions: "shorter title", destination: "ue-mcp" } });
  });

  it("declines", () => {
    render(<FormCard form={form} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(m.answerForm).toHaveBeenCalledWith("f1", { action: "decline" });
  });
});
