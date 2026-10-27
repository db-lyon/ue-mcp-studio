// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  config: vi.fn(),
  saveConfig: vi.fn(),
}));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
import { ConfigView } from "./Config";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FILE = { path: "C:/Projects/Game/ue-mcp.yml", exists: true, text: "context:\n  strategy: micro # default\n" };

async function show(file = FILE) {
  m.config.mockResolvedValue(file);
  await act(async () => void render(<ConfigView />));
  return screen.getByRole("textbox", { name: "ue-mcp.yml" }) as HTMLTextAreaElement;
}
const layer = () => document.querySelector(".yaml-layer") as HTMLElement;

describe("ue-mcp.yml editor", () => {
  it("shows the file in an editable box over a highlighted copy of it", async () => {
    const box = await show();
    expect(box.value).toBe(FILE.text);
    expect(layer().textContent).toBe(FILE.text);
    expect(layer().getAttribute("aria-hidden")).toBe("true");
    expect(layer().querySelector(".y-key")?.textContent).toBe("context");
    expect(layer().querySelector(".y-comment")?.textContent).toBe("# default");
  });

  it("re-highlights while typing and saves what was typed", async () => {
    const box = await show();
    const next = "context:\n  strategy: lean\nport: 9000\n";
    fireEvent.change(box, { target: { value: next } });
    expect(layer().textContent).toBe(next);
    expect([...layer().querySelectorAll(".y-number")].map((e) => e.textContent)).toEqual(["9000"]);
    m.saveConfig.mockResolvedValue({ ...FILE, text: next });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(m.saveConfig).toHaveBeenCalledWith(next);
    expect(screen.getByText("Saved. The server reloads it on the next call.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a refused save and keeps the edit", async () => {
    const box = await show();
    fireEvent.change(box, { target: { value: "context: [\n" } });
    m.saveConfig.mockRejectedValue(new Error("ue-mcp.yml is not valid YAML"));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByText("ue-mcp.yml is not valid YAML")).toBeTruthy();
    expect(box.value).toBe("context: [\n");
  });

  it("reverts to the file", async () => {
    const box = await show();
    fireEvent.change(box, { target: { value: "x: 1\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(box.value).toBe(FILE.text);
    expect(layer().textContent).toBe(FILE.text);
  });

  it("says when the file cannot be read", async () => {
    m.config.mockRejectedValue(new Error("no project"));
    await act(async () => void render(<ConfigView />));
    expect(screen.getByText("no project")).toBeTruthy();
  });

  it("indents with spaces on Tab and outdents on Shift+Tab", async () => {
    const box = await show({ ...FILE, text: "a:\nb: 1\n" });
    box.setSelectionRange(3, 3);
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("a:\n  b: 1\n");
    expect(layer().textContent).toBe("a:\n  b: 1\n");
    box.setSelectionRange(5, 5);
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(box.value).toBe("a:\nb: 1\n");
  });

  it("indents every selected line", async () => {
    const box = await show({ ...FILE, text: "a: 1\nb: 2\nc: 3\n" });
    box.setSelectionRange(0, 9);
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("  a: 1\n  b: 2\nc: 3\n");
  });

  it("lets Tab leave the box after Escape", async () => {
    const box = await show();
    fireEvent.keyDown(box, { key: "Escape" });
    const tab = fireEvent.keyDown(box, { key: "Tab" });
    expect(tab).toBe(true);
    expect(box.value).toBe(FILE.text);
  });
});
