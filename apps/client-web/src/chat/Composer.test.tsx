// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({
  api: { uploadAttachment: vi.fn(async (_id: string, u: { name: string; type: string; data: string }) => ({ id: `id-${u.name}`, name: u.name, type: u.type, size: 3 })) },
}));
import { api } from "../api";
import { Composer } from "./Composer";
import { useAttachments, type PendingFile } from "./attachments";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = {
  draft: "", onDraft: vi.fn(), onBlur: vi.fn(), placeholder: "Ask", busy: false, canSend: true,
  onSend: vi.fn(), onStop: vi.fn(), files: [] as PendingFile[], onAddFiles: vi.fn(), onRemoveFile: vi.fn(), picker: null,
};

describe("the composer", () => {
  it("attaches pasted files and leaves pasted text alone", () => {
    const onAddFiles = vi.fn();
    render(<Composer {...base} onAddFiles={onAddFiles} />);
    const box = screen.getByPlaceholderText("Ask");
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [file], types: ["Files"] } });
    expect(onAddFiles).toHaveBeenCalledWith([file]);
    onAddFiles.mockClear();
    fireEvent.paste(box, { clipboardData: { files: [], types: ["text/plain"] } });
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it("sends on Enter only when it can, and keeps Shift+Enter for a new line", () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer {...base} onSend={onSend} canSend={false} />);
    const box = screen.getByPlaceholderText("Ask");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    rerender(<Composer {...base} onSend={onSend} canSend />);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("shows each file with its state, and removes one", () => {
    const onRemoveFile = vi.fn();
    const files: PendingFile[] = [
      { key: "a", name: "rock.fbx", type: "application/octet-stream", size: 2048, preview: null, state: "ready" },
      { key: "b", name: "big.mp4", type: "video/mp4", size: 1, preview: null, state: "error", error: "larger than 100.0 MB" },
    ];
    render(<Composer {...base} files={files} onRemoveFile={onRemoveFile} />);
    expect(screen.getByText("rock.fbx")).toBeTruthy();
    expect(screen.getByText("FBX")).toBeTruthy();
    expect(screen.getByText("larger than 100.0 MB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove rock.fbx" }));
    expect(onRemoveFile).toHaveBeenCalledWith("a");
  });
});

describe("adding files", () => {
  it("uploads each file as it is added, and offers the uploaded ones for the next message", async () => {
    globalThis.URL.createObjectURL = vi.fn(() => "blob:preview");
    globalThis.URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useAttachments("s1"));
    act(() => result.current.add([new File(["abc"], "ref.png", { type: "image/png" }), new File(["abc"], "notes.txt", { type: "text/plain" })]));
    expect(result.current.uploading).toBe(true);
    await waitFor(() => expect(result.current.ready).toHaveLength(2));
    expect(api.uploadAttachment).toHaveBeenCalledWith("s1", { name: "ref.png", type: "image/png", data: "YWJj" });
    expect(result.current.files[0].preview).toBe("blob:preview");
    act(() => result.current.clear());
    expect(result.current.files).toHaveLength(0);
  });

  it("refuses a file over the limit without uploading it", () => {
    const { result } = renderHook(() => useAttachments("s1"));
    const huge = new File(["x"], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(huge, "size", { value: 200 * 1024 * 1024 });
    act(() => result.current.add([huge]));
    expect(result.current.files[0].state).toBe("error");
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });
});
