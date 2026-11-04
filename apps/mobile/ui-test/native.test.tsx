import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Scanner } from "../src/screens/Scanner";
import { About } from "../src/screens/About";
import { settle } from "./helpers";

describe("Scanner", () => {
  it("hands over the first code read and switches the torch", () => {
    const codes: string[] = [];
    (globalThis as { __scan?: string }).__scan = "https://remote.ue-mcp.com/pair#a.b.c";
    render(<Scanner onCode={(c) => codes.push(c)} onCancel={() => undefined} />);
    expect(screen.getByText("Point the camera at the pairing code Studio shows on your computer.")).toBeTruthy();
    const torch = screen.getByLabelText("Torch");
    fireEvent.click(torch);
    expect(torch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByText("Camera preview"));
    fireEvent.click(screen.getByText("Camera preview"));
    expect(codes).toEqual(["https://remote.ue-mcp.com/pair#a.b.c"]);
  });

  it("closes", () => {
    const cancel = vi.fn();
    render(<Scanner onCode={() => undefined} onCancel={cancel} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(cancel).toHaveBeenCalled();
  });
});

describe("About", () => {
  it("names this app's version and what it needs from Studio", async () => {
    render(<About onBack={() => undefined} />);
    await settle();
    expect(screen.getByText("UE-MCP Studio 0.2.0")).toBeTruthy();
    expect(screen.getByText(/or newer$/)).toBeTruthy();
    expect(screen.getByText("Open a project to see what its computer runs.")).toBeTruthy();
  });
});
