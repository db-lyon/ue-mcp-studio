// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ signIn: vi.fn(), startSignIn: vi.fn(), cancelSignIn: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { SignInForm } from "./ModelPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TERMINAL = `& "C:\\rt\\claude.exe" auth login --claudeai`;

describe("the Claude row", () => {
  it("has no sign-in button: it names Claude Code's login and the runtime's command", async () => {
    m.signIn.mockResolvedValue({ state: "idle", terminal: TERMINAL });
    await act(async () => render(<SignInForm id="claude" onDone={() => {}} />));
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
    expect(screen.getByText("claude /login")).toBeTruthy();
    expect(screen.getByText(TERMINAL)).toBeTruthy();
    expect(m.startSignIn).not.toHaveBeenCalled();
    expect(document.querySelector("input")).toBeNull();
  });

  it("finishes when Studio sees the login", async () => {
    const onDone = vi.fn();
    m.signIn.mockResolvedValue({ state: "done", login: "Claude max" });
    await act(async () => render(<SignInForm id="claude" onDone={onDone} />));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Signed in to Claude.")).toBeTruthy();
  });
});
