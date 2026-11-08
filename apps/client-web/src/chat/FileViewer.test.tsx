// @vitest-environment jsdom
/** File links in a reply: the one link model, and the read-only viewer they open. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FileReadResponse } from "@ue-mcp-studio/shared";

const files: Record<string, string> = {
  ".wiki/Decisions.md": "# Decisions\n\nSee the [index](Index.md) and the [readme](../README.md).",
  ".wiki/Index.md": "# Index\n\nEvery page.",
  "README.md": "# Vale",
  "Source/Door.cpp": "#include \"Door.h\"\n\nvoid ADoor::Open()\n{\n}\n",
};
const remote = vi.hoisted(() => ({ on: false }));
vi.mock("../connection", () => ({ onRemotePage: () => remote.on }));
vi.mock("../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      readFile: vi.fn(async (path: string): Promise<FileReadResponse> => {
        if (!(path in files)) throw new ApiError(404, `${path} does not exist.`);
        return { path, text: files[path], size: files[path].length };
      }),
      openFile: vi.fn(async () => undefined),
      openAsset: vi.fn(async (path: string) => ({ path, alreadyOpen: false })),
      resolveAssets: vi.fn(),
      reportAssetMiss: vi.fn(async () => undefined),
    },
  };
});
import { api } from "../api";
import { FileViewerProvider } from "./FileViewer";
import { Reply } from "./Transcript";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  remote.on = false;
});

const reply = async (text: string) => {
  await act(async () => void render(<FileViewerProvider><Reply text={text} /></FileViewerProvider>));
  return document.querySelector(".msg.assistant") as HTMLElement;
};
const click = async (el: Element) => act(async () => void fireEvent.click(el));

describe("links in a reply", () => {
  it("draws each kind once: web opens outside, a file is a viewer link, anything else is text", async () => {
    const msg = await reply("[docs](https://ue-mcp.com/docs/), [.wiki/Decisions.md](.wiki/Decisions.md), [Door](/Game/BP/BP_Door) and [run](javascript:alert(1)).");
    const web = within(msg).getByRole("link", { name: "docs" });
    expect(web.getAttribute("href")).toBe("https://ue-mcp.com/docs/");
    expect(web.getAttribute("target")).toBe("_blank");
    expect(within(msg).getByRole("button", { name: ".wiki/Decisions.md" }).className).toContain("file-link");
    expect(within(msg).getByRole("button", { name: "Door" }).getAttribute("title")).toBe("/Game/BP/BP_Door.BP_Door");
    expect(msg.textContent).toContain(" and run.");
    expect(within(msg).queryByRole("button", { name: "run" })).toBeNull();
    expect(msg.querySelectorAll("a")).toHaveLength(1);
  });
});

describe("the file viewer", () => {
  it("opens a relative .md link as markdown, and a link inside it resolves against that file", async () => {
    const msg = await reply("Recorded in [.wiki/Decisions.md](.wiki/Decisions.md).");
    await click(within(msg).getByRole("button", { name: ".wiki/Decisions.md" }));
    expect(api.readFile).toHaveBeenCalledWith(".wiki/Decisions.md");
    let viewer = screen.getByRole("dialog", { name: ".wiki/Decisions.md" });
    expect(within(viewer).getByRole("heading", { name: "Decisions" })).toBeTruthy();

    await click(within(viewer).getByRole("button", { name: "index" }));
    expect(api.readFile).toHaveBeenLastCalledWith(".wiki/Index.md");
    viewer = screen.getByRole("dialog", { name: ".wiki/Index.md" });
    expect(within(viewer).getByRole("heading", { name: "Index" })).toBeTruthy();

    await click(within(viewer).getByRole("button", { name: "Back" }));
    viewer = screen.getByRole("dialog", { name: ".wiki/Decisions.md" });
    await click(within(viewer).getByRole("button", { name: "readme" }));
    expect(api.readFile).toHaveBeenLastCalledWith("README.md");
    expect(within(screen.getByRole("dialog", { name: "README.md" })).getByRole("heading", { name: "Vale" })).toBeTruthy();

    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows other text as numbered lines, marking the line the link named", async () => {
    const msg = await reply("The fix is in [Door.cpp](Source/Door.cpp#L3).");
    await click(within(msg).getByRole("button", { name: "Door.cpp" }));
    const viewer = screen.getByRole("dialog", { name: "Source/Door.cpp" });
    const lines = [...viewer.querySelectorAll(".file-line")];
    expect(lines.map((l) => l.querySelector(".file-line-no")?.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(viewer.querySelector(".file-line.current .file-line-text")?.textContent).toBe("void ADoor::Open()");
    expect(viewer.querySelector(".file-viewer-path")?.textContent).toBe("Source/Door.cpp:3");
  });

  it("says what the agent said when the file is missing", async () => {
    const msg = await reply("See [notes](.wiki/Gone.md).");
    await click(within(msg).getByRole("button", { name: "notes" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe(".wiki/Gone.md does not exist.");
  });

  it("opens a text file in the computer's editor, and offers no such thing to a paired browser", async () => {
    const msg = await reply("[Decisions](.wiki/Decisions.md)");
    await click(within(msg).getByRole("button", { name: "Decisions" }));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Open in editor" }));
    expect(api.openFile).toHaveBeenCalledWith(".wiki/Decisions.md");
    cleanup();
    remote.on = true;
    const again = await reply("[Decisions](.wiki/Decisions.md)");
    await click(within(again).getByRole("button", { name: "Decisions" }));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Open in editor" })).toBeNull();
  });
});
