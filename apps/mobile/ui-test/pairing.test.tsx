import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { Pairing, Welcome } from "../src/screens/Pairing";
import { Scanner } from "../src/screens/Scanner";
import { settle } from "./helpers";

const relay = vi.hoisted(() => ({
  account: vi.fn(),
  trusted: vi.fn(),
  removeViewer: vi.fn(),
  forgetComputer: vi.fn(),
}));
vi.mock("../src/relay", async (orig) => ({ ...(await orig<object>()), ...relay }));

const { Projects } = await import("../src/screens/Projects");
const { Settings } = await import("../src/screens/Settings");

describe("pairing screens", () => {
  it("scans or takes a pasted link", () => {
    const links: string[] = [];
    render(<Welcome onScan={() => links.push("scan")} onLink={(l) => links.push(l)} />);
    fireEvent.click(screen.getByText("Scan pairing code"));
    fireEvent.change(screen.getByPlaceholderText("https://remote.ue-mcp.com/pair#..."), { target: { value: "https://remote.ue-mcp.com/pair#a.b.c" } });
    fireEvent.click(screen.getByText("Pair with link"));
    expect(links).toEqual(["scan", "https://remote.ue-mcp.com/pair#a.b.c"]);
  });

  it("says why the last pairing failed", () => {
    render(<Welcome error="That code is used or expired." onScan={() => undefined} onLink={() => undefined} />);
    expect(screen.getByText("That code is used or expired.")).toBeTruthy();
  });

  it("hands over the first code the camera reads, once", () => {
    const codes: string[] = [];
    (globalThis as { __scan?: string }).__scan = "https://remote.ue-mcp.com/pair#x.y.z";
    render(<Scanner onCode={(c) => codes.push(c)} onCancel={() => undefined} />);
    fireEvent.click(screen.getByText("Camera preview"));
    fireEvent.click(screen.getByText("Camera preview"));
    expect(codes).toEqual(["https://remote.ue-mcp.com/pair#x.y.z"]);
  });

  it("shows the code to compare while the owner decides", () => {
    render(<Pairing step={{ kind: "code", code: "123456" }} />);
    expect(screen.getByText("123 456")).toBeTruthy();
    expect(screen.getByText(/choose Deny there/)).toBeTruthy();
  });
});

describe("Projects and Devices", () => {
  beforeEach(() => {
    relay.trusted.mockResolvedValue({ keyA: { pairedAt: "2026-11-01T00:00:00Z" } });
    relay.account.mockResolvedValue({
      devices: [
        { id: "d1", name: "Lyra", online: true, computerKey: "keyA", lastSeen: "2026-11-04T12:00:00Z" },
        { id: "d2", name: "Other", online: true, computerKey: "keyB", lastSeen: "2026-11-04T12:00:00Z" },
      ],
      viewers: [
        { id: "v1", label: "Android (Studio app)", createdAt: "2026-11-01T00:00:00Z", current: true },
        { id: "v2", label: "Windows (Edge)", createdAt: "2026-10-01T00:00:00Z", current: false },
      ],
    });
  });

  it("opens a paired project and explains an unpaired one", async () => {
    const opened: string[] = [];
    render(<Projects onOpen={(d) => opened.push(d.id)} onPair={() => undefined} onSettings={() => undefined} onUnpaired={() => undefined} />);
    await settle();
    expect(screen.getByText("Online. Scan this computer's pairing code to open it here.")).toBeTruthy();
    fireEvent.click(screen.getByText("Lyra"));
    fireEvent.click(screen.getByText("Other"));
    expect(opened).toEqual(["d1"]);
  });

  it("removes another browser after confirming", async () => {
    const spy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    relay.removeViewer.mockResolvedValue(undefined);
    render(<Settings onBack={() => undefined} onRemoved={() => undefined} />);
    await settle();
    expect(screen.getByText("Android (Studio app) (this phone)")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Remove")[1]);
    const buttons = spy.mock.calls.at(-1)?.[2] ?? [];
    buttons.find((b) => b.text === "Remove")?.onPress?.();
    expect(relay.removeViewer).toHaveBeenCalledWith(expect.objectContaining({ id: "v2" }));
    expect(screen.getByText("Lyra")).toBeTruthy();
    spy.mockRestore();
  });
});
