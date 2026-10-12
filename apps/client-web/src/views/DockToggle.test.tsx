// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockToggle, parseWindowMode } from "./DockToggle";

afterEach(() => {
  cleanup();
  delete window.ue;
});

function bind(mode: "docked" | "window", canDock: boolean) {
  const set = vi.fn(async () => true);
  window.ue = { studio: { restarteditor: async () => false, enableplugin: async () => false, openprojectfolder: async () => false, getwindowmode: async () => JSON.stringify({ mode, canDock }), setwindowmode: set } };
  return set;
}

describe("the dock toggle", () => {
  it("parses the window's answer", () => {
    expect(parseWindowMode('{"mode":"docked","canDock":true}')).toEqual({ mode: "docked", canDock: true });
    expect(parseWindowMode('{"mode":"window"}')).toEqual({ mode: "window", canDock: false });
    expect(parseWindowMode('{"mode":"floating"}')).toBeNull();
    expect(parseWindowMode("not json")).toBeNull();
    expect(parseWindowMode(undefined)).toBeNull();
  });

  it("offers docking in a window whose editor plugin has the dock tab, and docks", async () => {
    const set = bind("window", true);
    render(<DockToggle />);
    fireEvent.click(await screen.findByLabelText("Dock in editor"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("docked"));
    await screen.findByLabelText("Open as window");
  });

  it("offers a window when docked", async () => {
    const set = bind("docked", true);
    render(<DockToggle />);
    fireEvent.click(await screen.findByLabelText("Open as window"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("window"));
  });

  it("shows nothing with an older plugin, or outside Studio's window", async () => {
    bind("window", false);
    const { container } = render(<DockToggle />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    cleanup();
    delete window.ue;
    expect(render(<DockToggle />).container.textContent).toBe("");
  });
});
