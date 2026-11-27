// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ answerForm: vi.fn(async () => {}) }));
vi.mock("../api", () => ({ api: m }));
import { FormCard, FormCards } from "./Forms";

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

describe("the agent's ask_user question", () => {
  const ask = (other: boolean) => ({
    id: "f3", sessionId: "s1", call: "ask_user", at: "", message: "Which door?",
    fields: { choice: { type: "string" as const, title: "Choice", enum: ["Oak", "Steel", "Glass"] }, ...(other ? { other: { type: "string" as const, title: "Something else" } } : {}) },
    required: other ? [] : ["choice"],
  });

  it("answers with the option tapped, with no Submit", () => {
    render(<FormCards forms={[ask(false)]} />);
    expect(screen.getByRole("group", { name: "A question from the agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.queryByLabelText("Your own answer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Steel" }));
    expect(m.answerForm).toHaveBeenCalledWith("f3", { action: "accept", content: { choice: "Steel" } });
  });

  it("sends an answer in the user's own words when the question allows one, and declines", () => {
    render(<FormCards forms={[ask(true)]} />);
    fireEvent.change(screen.getByLabelText("Your own answer"), { target: { value: " a curtain " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(m.answerForm).toHaveBeenCalledWith("f3", { action: "accept", content: { other: "a curtain" } });
    cleanup();
    render(<FormCards forms={[ask(true)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(m.answerForm).toHaveBeenLastCalledWith("f3", { action: "decline" });
  });
});

