// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ signIn: vi.fn(), startSignIn: vi.fn(), cancelSignIn: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { SignInForm } from "./ModelPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TERMINAL = `$env:CLAUDE_CONFIG_DIR = "C:\\h"; & "C:\\rt\\claude.exe" auth login --claudeai`;

describe("the Claude sign-in", () => {
  it("leaves the browser to Claude's runtime, asks for no code, and offers the terminal command", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    m.signIn.mockResolvedValue({ state: "idle" });
    m.startSignIn.mockResolvedValue({ state: "pending", terminal: TERMINAL, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await act(async () => render(<SignInForm id="claude" onDone={() => {}} />));
    await act(async () => fireEvent.click(screen.getByText("Sign in to Claude subscription")));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText(/sign-in page opened in your browser/)).toBeTruthy();
    expect(screen.getByText(TERMINAL)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Code")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
  });

  it("shows the terminal command beside a failed sign-in", async () => {
    m.signIn.mockResolvedValue({ state: "error", error: "The sign-in did not complete.", terminal: TERMINAL });
    await act(async () => render(<SignInForm id="claude" onDone={() => {}} />));
    expect(screen.getByText("The sign-in did not complete.")).toBeTruthy();
    expect(screen.getByText(TERMINAL)).toBeTruthy();
  });
});
