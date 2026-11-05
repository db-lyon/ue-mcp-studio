import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { VcsStatus } from "@ue-mcp-studio/shared";
import { store } from "./mocks/secure-store";
import { ChangesSheet, GitDiffLine, VIEW_KEY } from "../src/screens/git/ChangesSheet";
import { VcsChip, VCS_POLL_MS, useChangesSheet } from "../src/screens/git/VcsChip";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

const vcs: VcsStatus = { kind: "git", name: "Git", branch: "main", changes: 3, ahead: 1, behind: 0, root: "D:/Game" } as VcsStatus;
const changes = [
  { path: "Content/Props/Door.uasset", status: "modified" as const },
  { path: "Content/Props/Lamp.uasset", status: "added" as const },
  { path: "Source/Game/Door.cpp", status: "deleted" as const },
];

function sheet(over: { changes?: typeof changes; truncated?: boolean } = {}) {
  const api = fakeApi();
  api.vcsChanges.mockResolvedValue({ changes: over.changes ?? changes, truncated: !!over.truncated });
  const onClose = vi.fn();
  const view = renderInProject(<ChangesSheet vcs={vcs} onClose={onClose} />, api);
  return { ...view, onClose };
}

afterEach(() => store.clear());

describe("ChangesSheet", () => {
  it("says Loading until the list arrives", () => {
    renderInProject(<ChangesSheet vcs={vcs} onClose={() => undefined} />);
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.getByText("Git, main, 3 changed, 1 ahead")).toBeTruthy();
  });

  it("lists each file with its status letter and folder", async () => {
    sheet();
    await settle();
    expect(screen.getByText("Door.uasset")).toBeTruthy();
    expect(screen.getAllByText("Content/Props")).toHaveLength(2);
    expect(screen.getByText("M")).toBeTruthy();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("D")).toBeTruthy();
    expect(screen.queryByText("Expand all")).toBeNull();
  });

  it("says No changes. for a clean project", async () => {
    sheet({ changes: [] });
    await settle();
    expect(screen.getByText("No changes.")).toBeTruthy();
    expect(screen.queryByText("List")).toBeNull();
  });

  it("says when more files changed than are listed", async () => {
    sheet({ truncated: true });
    await settle();
    expect(screen.getByText("More files changed than are listed.")).toBeTruthy();
  });

  it("switches to a folder tree, keeps the choice, and expands and collapses folders", async () => {
    sheet();
    await settle();
    fireEvent.click(screen.getByText("Tree"));
    expect(store.get(VIEW_KEY)).toBe("tree");
    expect(screen.getByLabelText("Content/Props")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Content/Props"));
    expect(screen.queryByText("Lamp.uasset")).toBeNull();
    expect(screen.getByText("Door.cpp")).toBeTruthy();
    fireEvent.click(screen.getByText("Collapse all"));
    expect(screen.queryByText("Door.cpp")).toBeNull();
    fireEvent.click(screen.getByText("Expand all"));
    expect(screen.getByText("Lamp.uasset")).toBeTruthy();
    fireEvent.click(screen.getByText("List"));
    expect(store.get(VIEW_KEY)).toBe("list");
  });

  it("opens in the view picked last time", async () => {
    store.set(VIEW_KEY, "tree");
    sheet();
    await settle();
    expect(screen.getByText("Expand all")).toBeTruthy();
  });

  it("drills into a file's diff and comes back", async () => {
    const { api } = sheet();
    api.vcsDiff.mockResolvedValue({ diff: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n same" });
    await settle();
    fireEvent.click(screen.getByLabelText("deleted Source/Game/Door.cpp"));
    expect(api.vcsDiff).toHaveBeenCalledWith("Source/Game/Door.cpp");
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.getByText("Source/Game/Door.cpp")).toBeTruthy();
    await settle();
    expect(screen.getByText("old")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
    expect(screen.getByText("@@ -1 +1 @@")).toBeTruthy();
    expect(screen.queryByText("Tree")).toBeNull();
    fireEvent.click(screen.getByLabelText("Back to the changed files"));
    expect(screen.getByText("Tree")).toBeTruthy();
  });

  it("says why a file has no diff, and what failed", async () => {
    const { api } = sheet();
    api.vcsDiff.mockResolvedValueOnce({ diff: null, reason: "Binary file." }).mockRejectedValueOnce(new Error("git failed"));
    await settle();
    fireEvent.click(screen.getByLabelText("modified Content/Props/Door.uasset"));
    await settle();
    expect(screen.getByText("Binary file.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Back to the changed files"));
    fireEvent.click(screen.getByLabelText("added Content/Props/Lamp.uasset"));
    await settle();
    expect(screen.getByText("git failed")).toBeTruthy();
  });

  it("goes back from the diff, then closes, on the system back (Escape on the web)", async () => {
    const { api, onClose } = sheet();
    api.vcsDiff.mockResolvedValue({ diff: "+x" });
    await settle();
    fireEvent.click(screen.getByLabelText("deleted Source/Game/Door.cpp"));
    fireEvent.keyUp(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Tree")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyUp(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from Close", async () => {
    const { onClose } = sheet();
    await settle();
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("GitDiffLine", () => {
  it("keeps a header or hunk on one line and splits a change into its sign and text", () => {
    renderInProject(
      <>
        <GitDiffLine line="--- a/x" />
        <GitDiffLine line="+added" />
      </>,
    );
    expect(screen.getByText("--- a/x")).toBeTruthy();
    expect(screen.getByText("+")).toBeTruthy();
    expect(screen.getByText("added")).toBeTruthy();
  });
});

describe("VcsChip", () => {
  it("shows the kind and status, and opens the sheet", async () => {
    const api = fakeApi();
    api.vcs.mockResolvedValue({ vcs });
    api.vcsChanges.mockResolvedValue({ changes, truncated: false });
    renderInProject(<VcsChip />, api);
    await settle();
    expect(screen.getByText("Git")).toBeTruthy();
    expect(screen.getByText("main, 3 changed, 1 ahead")).toBeTruthy();
    fireEvent.click(screen.getByTestId("vcs-chip"));
    await settle();
    expect(screen.getByText("Door.uasset")).toBeTruthy();
  });

  it("shows nothing without source control", async () => {
    const api = fakeApi();
    api.vcs.mockResolvedValue({ vcs: null });
    renderInProject(<VcsChip />, api);
    await settle();
    expect(screen.queryByTestId("vcs-chip")).toBeNull();
  });

  it("reads again when a session changes and every half minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const api = fakeApi();
      api.vcs.mockResolvedValue({ vcs });
      const { project, emit } = fakeProject();
      renderInProject(<VcsChip />, api, project);
      await settle();
      expect(api.vcs).toHaveBeenCalledTimes(1);
      emit("studio.session.changed", {});
      expect(api.vcs).toHaveBeenCalledTimes(2);
      emit("studio.transcript.added", {});
      expect(api.vcs).toHaveBeenCalledTimes(2);
      act(() => void vi.advanceTimersByTime(VCS_POLL_MS));
      expect(api.vcs).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useChangesSheet", () => {
  function Opener() {
    const c = useChangesSheet();
    return (
      <>
        <button onClick={c.open}>Changes</button>
        {c.error ? <span>{c.error}</span> : null}
        {c.sheet}
      </>
    );
  }

  it("opens the sheet once the source control is read", async () => {
    const api = fakeApi();
    api.vcs.mockResolvedValue({ vcs });
    api.vcsChanges.mockResolvedValue({ changes, truncated: false });
    renderInProject(<Opener />, api);
    fireEvent.click(screen.getByText("Changes"));
    await settle();
    await settle();
    expect(screen.getByText("Door.cpp")).toBeTruthy();
  });

  it("says when the project has no source control", async () => {
    const api = fakeApi();
    api.vcs.mockResolvedValue({ vcs: null });
    renderInProject(<Opener />, api);
    fireEvent.click(screen.getByText("Changes"));
    await settle();
    expect(screen.getByText("This project has no source control Studio can read.")).toBeTruthy();
  });
});
