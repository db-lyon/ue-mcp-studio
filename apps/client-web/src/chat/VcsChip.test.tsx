// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VcsStatus } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ vcs: vi.fn(), vcsChanges: vi.fn(), vcsDiff: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { VcsChip, buildTree, folderPaths, readView, treeRows, vcsLine } from "./VcsChip";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
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
    m.vcsDiff.mockImplementation(async (p: string) => (p.endsWith(".ini") ? { diff: "diff --git a/Config/DefaultEngine.ini b/Config/DefaultEngine.ini\n@@ -1 +1 @@\n-old\n+new" } : { diff: null, reason: "A binary file, so there is no text diff." }));
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

describe("the changes as a folder tree", () => {
  const changes = [
    { path: "Content/Props/Door/BP_Door.uasset", status: "modified" as const },
    { path: "Content/Props/Door/C_Hinge.uasset", status: "added" as const },
    { path: "Content/Maps/L_Main.umap", status: "modified" as const },
    { path: "Config/DefaultEngine.ini", status: "modified" as const },
    { path: "README.md", status: "untracked" as const },
  ];

  it("nests folders first, counts the changes under each, and folds a single-child chain into one row", () => {
    const tree = buildTree(changes);
    expect(tree.folders.map((f) => [f.name, f.count])).toEqual([["Config", 1], ["Content", 3]]);
    const content = tree.folders[1];
    expect(content.folders.map((f) => [f.name, f.count])).toEqual([["Maps", 1], ["Props/Door", 2]]);
    expect(tree.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(folderPaths(tree)).toEqual(["Config", "Content", "Content/Maps", "Content/Props/Door"]);
    const rows = treeRows(tree, new Set(["Content/Maps"]));
    expect(rows.map((r) => (r.kind === "folder" ? `${"  ".repeat(r.depth)}${r.name}/ ${r.count}` : `${"  ".repeat(r.depth)}${r.change.path}`))).toEqual([
      "Config/ 1",
      "  Config/DefaultEngine.ini",
      "Content/ 3",
      "  Maps/ 1",
      "  Props/Door/ 2",
      "    Content/Props/Door/BP_Door.uasset",
      "    Content/Props/Door/C_Hinge.uasset",
      "README.md",
    ]);
  });

  it("switches between list and tree, collapses and expands, and remembers the choice", async () => {
    m.vcs.mockResolvedValue({ vcs: git });
    m.vcsChanges.mockResolvedValue({ changes, truncated: false });
    m.vcsDiff.mockResolvedValue({ diff: null, reason: "A binary file, so there is no text diff." });
    render(<VcsChip events={[]} />);
    await waitFor(() => expect(screen.getByText(/main, 3 changed/)).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Git/ })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tree" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Collapse all" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tree" })));
    expect(readView()).toBe("tree");
    expect(screen.getByTitle("Content/Props/Door").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTitle("Content/Props/Door/C_Hinge.uasset")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTitle("Content/Props/Door")));
    expect(screen.queryByTitle("Content/Props/Door/C_Hinge.uasset")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Collapse all" })));
    expect(screen.queryByTitle("Config/DefaultEngine.ini")).toBeNull();
    expect(screen.getByTitle("README.md")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Expand all" })));
    expect(screen.getByTitle("Content/Props/Door/C_Hinge.uasset")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Git/ })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tree" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("falls back to the list when storage throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readView()).toBe("list");
    get.mockRestore();
  });
});

describe("the changes on a narrow panel", () => {
  const narrow = (on: boolean) => {
    window.matchMedia = ((q: string) => ({ matches: on && q.includes("max-width: 760px"), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => narrow(false));

  it("shows only the file list, opens a diff in its place, and Back returns to the list", async () => {
    narrow(true);
    m.vcs.mockResolvedValue({ vcs: git });
    m.vcsChanges.mockResolvedValue({ changes: [{ path: "Config/DefaultEngine.ini", status: "modified" }, { path: "Content/Map.umap", status: "added" }], truncated: false });
    m.vcsDiff.mockResolvedValue({ diff: "@@ -1 +1 @@\n-old\n+new" });
    render(<VcsChip events={[]} />);
    await waitFor(() => expect(screen.getByText(/main, 3 changed, 2 ahead/)).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Git/ })));
    await waitFor(() => expect(screen.getByTitle("Content/Map.umap")).toBeTruthy());
    expect(document.querySelector(".changes-diff")).toBeNull();
    expect(m.vcsDiff).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByTitle("Content/Map.umap")));
    await waitFor(() => expect(document.querySelector("pre.diff .diff-line.add")).not.toBeNull());
    expect(document.querySelector(".changes-list")).toBeNull();
    expect(document.querySelector(".changes-toolbar")).toBeNull();
    expect(document.querySelector(".changes-detail-name")?.textContent).toBe("Map.umap");

    fireEvent.click(screen.getByRole("button", { name: "Back to the changed files" }));
    expect(document.querySelector(".changes-diff")).toBeNull();
    expect(screen.getByTitle("Config/DefaultEngine.ini")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Changes" })).toBeTruthy();
  });

  it("Escape goes back from a diff first, then closes", async () => {
    narrow(true);
    m.vcs.mockResolvedValue({ vcs: git });
    m.vcsChanges.mockResolvedValue({ changes: [{ path: "README.md", status: "modified" }], truncated: false });
    m.vcsDiff.mockResolvedValue({ diff: "+x" });
    render(<VcsChip events={[]} />);
    await waitFor(() => expect(screen.getByText(/main, 3 changed, 2 ahead/)).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Git/ })));
    await act(async () => fireEvent.click(await screen.findByTitle("README.md")));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Changes" })).toBeTruthy();
    expect(document.querySelector(".changes-diff")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
