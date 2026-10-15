// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QueuedMessage } from "@ue-mcp-studio/shared";
import { QueuedMessages } from "./Queue";

afterEach(cleanup);

const q = (id: string, text: string): QueuedMessage => ({ id, text, attachments: [], at: "t" });

describe("the queue", () => {
  const props = () => ({ queue: [q("a", "first"), q("b", "second")], busy: true, onEdit: vi.fn(), onRemove: vi.fn(), onSendNext: vi.fn() });

  it("lists queued messages in order and removes one", () => {
    const p = props();
    render(<QueuedMessages {...p} />);
    expect(screen.getByText("Queued (2), sent one by one as each turn ends")).toBeTruthy();
    expect(screen.getAllByText(/first|second/).map((e) => e.textContent)).toEqual(["first", "second"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message 2" }));
    expect(p.onRemove).toHaveBeenCalledWith("b");
  });

  it("edits one in place", () => {
    const p = props();
    render(<QueuedMessages {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    const box = screen.getByRole("textbox", { name: "Edit queued message 1" });
    fireEvent.change(box, { target: { value: "first, better" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(p.onEdit).toHaveBeenCalledWith("a", "first, better");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("offers Send next when no turn is running, and shows nothing when empty", () => {
    const p = { ...props(), busy: false };
    const { rerender } = render(<QueuedMessages {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Send next" }));
    expect(p.onSendNext).toHaveBeenCalled();
    rerender(<QueuedMessages {...p} queue={[]} />);
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
  });
});
