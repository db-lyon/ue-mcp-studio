// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { InstructionsView } from "@ue-mcp-studio/shared";

const view = (over: Partial<InstructionsView> = {}): InstructionsView => ({
  hasAgentsMd: false,
  alwaysTokens: 120,
  recognised: ["AGENTS.md", "CLAUDE.md"],
  files: [
    { path: ".github/copilot-instructions.md", convention: "copilot", order: 1, tokens: 40, on: true, scope: { kind: "always" }, readBy: ["main"] },
    { path: "CLAUDE.md", convention: "claude", order: 2, tokens: 80, on: true, scope: { kind: "always" }, readBy: ["main"] },
    { path: "Source/Game/AGENTS.md", convention: "nested", order: 3, tokens: 30, on: true, scope: { kind: "folder", folder: "Source/Game" }, readBy: ["main"] },
  ],
  ...over,
});
const m = vi.hoisted(() => ({
  instructions: vi.fn(),
  saveInstructions: vi.fn(),
  instructionsPreview: vi.fn(async () => ({ agent: "main", text: "## From CLAUDE.md\nRules.", tokens: 30, files: 2, conditional: [{ path: "Source/Game/AGENTS.md", scope: { kind: "folder", folder: "Source/Game" }, tokens: 30 }] })),
  createAgentsMd: vi.fn(),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
import { InstructionsPanel } from "./InstructionsPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function show(v = view()) {
  m.instructions.mockResolvedValue(v);
  m.saveInstructions.mockResolvedValue(v);
  await act(async () => void render(<InstructionsPanel agents={[{ id: "main", name: "Main agent" }]} />));
}

describe("Agents > Instructions", () => {
  it("lists every file in reading order, says when scoped ones apply, and previews the result", async () => {
    await show();
    expect([...document.querySelectorAll(".ifiles .ifile-main > .path")].map((e) => e.textContent)).toEqual([".github/copilot-instructions.md", "CLAUDE.md", "Source/Game/AGENTS.md"]);
    expect(screen.getByText("Only when an agent works in Source/Game.")).toBeTruthy();
    expect(screen.getByText(/2 files, 30 tokens on every call\. Plus Source\/Game\/AGENTS\.md \(30\)/)).toBeTruthy();
  });

  it("turns one file off", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Read CLAUDE.md" })));
    expect(m.saveInstructions).toHaveBeenCalledWith({ off: ["CLAUDE.md"] });
  });

  it("adds a file read where the user puts it", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add a file" })));
    fireEvent.change(screen.getByLabelText("File to add"), { target: { value: "docs/style.md" } });
    fireEvent.change(screen.getByLabelText("Read it after"), { target: { value: ".github/copilot-instructions.md" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(m.saveInstructions).toHaveBeenCalledWith({ added: [{ path: "docs/style.md", after: ".github/copilot-instructions.md" }] });
  });

  it("creates AGENTS.md and points CLAUDE.md at it unless the user unticks it", async () => {
    await show();
    m.createAgentsMd.mockResolvedValue({ written: "AGENTS.md", pointed: ["CLAUDE.md"], view: view({ hasAgentsMd: true }) });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Create AGENTS.md" })));
    expect((screen.getByRole("checkbox", { name: /make CLAUDE\.md import AGENTS\.md/ }) as HTMLInputElement).checked).toBe(true);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Create" })));
    expect(m.createAgentsMd).toHaveBeenCalledWith(["CLAUDE.md"]);
    expect(screen.getByText("Created AGENTS.md. CLAUDE.md now import it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create AGENTS.md" })).toBeNull();
  });
});
