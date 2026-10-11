// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { VcsStatus } from "@ue-mcp-studio/shared";

const vcs = vi.fn();
vi.mock("../api", () => ({ api: { vcs: () => vcs() } }));
import { VcsChip, vcsLine } from "./VcsChip";

afterEach(() => {
  cleanup();
  vcs.mockReset();
});

const git: VcsStatus = { kind: "git", name: "Git", branch: "main", changes: 3, ahead: 2, behind: 0, root: "C:/Game" };

describe("source control in the top bar", () => {
  it("says the branch, the changes and how far from upstream", () => {
    expect(vcsLine(git)).toBe("main, 3 changed, 2 ahead");
    expect(vcsLine({ ...git, changes: 0, ahead: 0 })).toBe("main, clean");
    expect(vcsLine({ kind: "perforce", name: "Perforce", branch: "//Game/main", changes: 4, root: "D:/Game" })).toBe("//Game/main, 4 opened");
    expect(vcsLine({ ...git, changes: null, ahead: 0 })).toBe("main");
  });

  it("shows the project's source control, and nothing when it has none", async () => {
    vcs.mockResolvedValueOnce({ vcs: git });
    const { unmount } = render(<VcsChip events={[]} />);
    await waitFor(() => expect(screen.getByText(/main, 3 changed, 2 ahead/)).toBeTruthy());
    expect(screen.getByText("Git")).toBeTruthy();
    unmount();
    vcs.mockResolvedValueOnce({ vcs: null });
    const { container } = render(<VcsChip events={[]} />);
    await waitFor(() => expect(vcs).toHaveBeenCalledTimes(2));
    expect(container.textContent).toBe("");
  });
});
