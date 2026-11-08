/** File links in a reply on the phone: the viewer they open, and links inside a viewed file. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Linking } from "react-native";
import { HttpError } from "@ue-mcp-studio/client-core";
import type { FileReadResponse } from "@ue-mcp-studio/shared";
import { FileViewerProvider } from "../src/chat/FileViewer";
import { Reply } from "../src/chat/Transcript";
import { fakeApi, renderInProject, settle } from "./helpers";

const files: Record<string, string> = {
  ".wiki/Decisions.md": "# Decisions\n\nSee the [index](Index.md).",
  ".wiki/Index.md": "# Index\n\nEvery page.",
  "Source/Door.cpp": "#include \"Door.h\"\n\nvoid ADoor::Open()\n{\n}\n",
};

function show(text: string) {
  const api = fakeApi();
  api.readFile.mockImplementation(async (path: string): Promise<FileReadResponse> => {
    if (!(path in files)) throw new HttpError(404, `${path} does not exist.`);
    return { path, text: files[path], size: files[path].length };
  });
  renderInProject(<FileViewerProvider><Reply text={text} /></FileViewerProvider>, api);
  return api;
}
const press = async (el: Element) => {
  await act(async () => void fireEvent.click(el));
  await settle();
};

afterEach(() => cleanup());

describe("links in a reply on the phone", () => {
  it("opens a web link outside the app and draws a link to nothing as text", async () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(true);
    show("[docs](https://ue-mcp.com/docs/) and [run](javascript:alert(1)).");
    await press(screen.getByRole("link", { name: "docs" }));
    expect(open).toHaveBeenCalledWith("https://ue-mcp.com/docs/");
    expect(screen.queryByRole("link", { name: "run" })).toBeNull();
    expect(screen.getByText(/and run\./)).toBeTruthy();
  });
});

describe("the file viewer on the phone", () => {
  it("opens a relative .md link as markdown, and a link inside it resolves against that file", async () => {
    const api = show("Recorded in [.wiki/Decisions.md](.wiki/Decisions.md).");
    await press(screen.getByRole("link", { name: ".wiki/Decisions.md" }));
    expect(api.readFile).toHaveBeenCalledWith(".wiki/Decisions.md");
    let viewer = screen.getByTestId("file-viewer");
    expect(viewer.getAttribute("aria-label")).toBe(".wiki/Decisions.md");
    expect(within(viewer).getByText("Decisions")).toBeTruthy();

    await press(within(viewer).getByRole("link", { name: "index" }));
    expect(api.readFile).toHaveBeenLastCalledWith(".wiki/Index.md");
    viewer = screen.getByTestId("file-viewer");
    expect(viewer.getAttribute("aria-label")).toBe(".wiki/Index.md");
    expect(within(viewer).getByText("Every page.")).toBeTruthy();

    await press(within(viewer).getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("file-viewer").getAttribute("aria-label")).toBe(".wiki/Decisions.md");
    await press(within(screen.getByTestId("file-viewer")).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("file-viewer")).toBeNull();
  });

  it("shows other text as numbered lines, marking the linked line, with no way to open it on the computer", async () => {
    show("The fix is in [Door.cpp](Source/Door.cpp:3).");
    await press(screen.getByRole("link", { name: "Door.cpp" }));
    const viewer = screen.getByTestId("file-viewer");
    expect(within(viewer).getByText("Source/Door.cpp:3")).toBeTruthy();
    expect(within(viewer).getByTestId("file-line-current").textContent).toBe("3void ADoor::Open()");
    expect(within(viewer).queryByRole("button", { name: "Open in editor" })).toBeNull();
  });

  it("says what the agent said when the file is missing", async () => {
    show("See [notes](.wiki/Gone.md).");
    await press(screen.getByRole("link", { name: "notes" }));
    expect(within(screen.getByTestId("file-viewer")).getByRole("alert").textContent).toBe(".wiki/Gone.md does not exist.");
  });
});
