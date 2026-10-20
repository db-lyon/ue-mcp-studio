// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { StudioSettings } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ signIn: vi.fn(), saveSettings: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { ProviderRow } from "./Settings";
import { CLAUDE_LOGIN_WHY } from "./ModelPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settings = (claude: boolean) => ({ connected: { claude }, account: null }) as unknown as StudioSettings;

describe("the Claude row in Settings", () => {
  it("says why there is no sign-in button while signed in, and offers no sign-out", async () => {
    await act(async () => render(<ProviderRow provider="claude" settings={settings(true)} onChange={() => {}} onError={() => {}} />));
    expect(screen.getByText("Why?").getAttribute("title")).toBe(CLAUDE_LOGIN_WHY);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("says why while signed out too", async () => {
    m.signIn.mockResolvedValue({ state: "idle" });
    await act(async () => render(<ProviderRow provider="claude" settings={settings(false)} onChange={() => {}} onError={() => {}} />));
    expect(screen.getByText("Why?").getAttribute("title")).toBe(CLAUDE_LOGIN_WHY);
  });
});
