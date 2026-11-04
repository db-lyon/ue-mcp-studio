// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VcsStatus } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ vcs: vi.fn(), vcsChanges: vi.fn(), vcsDiff: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { VcsChip, vcsLine } from "./VcsChip";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const git: VcsStatus = { kind: "git", name: "Git", branch: "main", changes: 3, ahead: 2, behind: 0, root: "C:/Game" };

describe("source control in the top bar", () => {
  it("says the branch, the changes and how far from upstream", () => {
    expect(vcsLine(git)).toBe("main, 3 changed, 2 ahead");
    expect(vcsLine({ ...git, changes: 0, ahead: 0 })).toBe("main, clean");
    expect(vcsLine({ kind: "perforce", name: "Perforce", branch: "//Game/main", changes: 4, root: "D:/Game" })).toBe("//Game/main, 4 opened");
    expect(vcsLine({ ...git, changes: null, ahead: 0 })).toBe("main");
  });

  it("shows nothing when the project has no source control", async () => {
    m.vcs.mockResolvedValue({ vcs: null });
    const { container } = render(<VcsChip events={[]} />);
    await waitFor(() => expect(m.vcs).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("opens the changes, and shows the picked file's diff", async () => {
    m.vcs.mockResolvedValue({ vcs: git });
    m.vcsChanges.mockResolvedValue({ changes: [{ path: "Config/DefaultEngine.ini", status: "modified" }, { path: "Content/Map.umap", status: "added" }], truncated: false });
    m.vcsDiff.mockImplementation(async (p: string) => (p.endsWith(".ini") ? { diff: "diff --git a/Config/DefaultEngine.ini b/Config/DefaultEngine.ini\n@@ -1 +1 @@\n-old\n+new" } : { diff: null, reason: "A binary file: open it in the editor to see it." }));
    render(<VcsChip events={[]} />);
    await waitFor(() => expect(screen.getByText(/main, 3 changed, 2 ahead/)).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Git/ })));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Changes" })).toBeTruthy());
    // Each change line is its sign in a gutter and its text beside it; the file header stays one line.
    await waitFor(() => expect(document.querySelector("pre.diff .diff-line.add")).not.toBeNull());
    const added = document.querySelector("pre.diff .diff-line.add")!;
    expect(added.querySelector(".diff-op")?.textContent).toBe("+");
    expect(added.querySelector(".diff-text")?.textContent).toBe("new\n");
    expect(document.querySelector("pre.diff .diff-line.del .diff-text")?.textContent).toBe("old\n");
    expect(document.querySelector("pre.diff .meta")?.getAttribute("title")).toBe("diff --git a/Config/DefaultEngine.ini b/Config/DefaultEngine.ini");
    expect(document.querySelector("pre.diff .hunk")?.textContent).toBe("@@ -1 +1 @@\n");
    await act(async () => fireEvent.click(screen.getByTitle("Content/Map.umap")));
    await waitFor(() => expect(screen.getByText(/A binary file/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
