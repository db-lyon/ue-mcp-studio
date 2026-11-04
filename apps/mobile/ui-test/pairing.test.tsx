import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { createLock, type Transport } from "@ue-mcp-studio/client-core";
import { PinPad } from "../src/PinPad";
import { Pairing, Scanner, Welcome } from "../src/screens/Pairing";
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

function lockAnswering(answer: (pin: string) => { status: number; body: unknown }) {
  const t: Transport = async (_m, path, o) => {
    const r = path.endsWith("/unlock") ? answer((o?.json as { pin: string }).pin) : { status: 200, body: { whole: true, sensitive: false, locked: true, sensitiveOpen: false, idleMinutes: 5, pinLength: 4 } };
    return {
      status: r.status,
      headers: {},
      body: (async function* () {
        yield new TextEncoder().encode(JSON.stringify(r.body));
      })(),
    };
  };
  return createLock(t);
}

describe("PinPad", () => {
  it("submits on the last digit when the PIN's length is known", async () => {
    const pins: string[] = [];
    const lock = lockAnswering((pin) => (pins.push(pin), { status: 403, body: { error: "Wrong PIN.", remaining: 2 } }));
    await lock.refresh();
    render(<PinPad lock={lock} view={lock.view()} onRemoved={() => undefined} />);
    expect(screen.getByText("Studio is locked")).toBeTruthy();
    for (const d of ["1", "2", "3", "4"]) fireEvent.click(screen.getByText(d));
    await settle();
    expect(pins).toEqual(["1234"]);
    expect(screen.getByText("Wrong PIN. 2 tries left.")).toBeTruthy();
  });

  it("deletes a digit", async () => {
    const pins: string[] = [];
    const lock = lockAnswering((pin) => (pins.push(pin), { status: 200, body: { whole: true, locked: false } }));
    await lock.refresh();
    render(<PinPad lock={lock} view={lock.view()} onRemoved={() => undefined} />);
    for (const d of ["9", "9"]) fireEvent.click(screen.getByText(d));
    fireEvent.click(screen.getByLabelText("Delete"));
    for (const d of ["1", "2", "3"]) fireEvent.click(screen.getByText(d));
    await settle();
    expect(pins).toEqual(["9123"]);
  });

  it("counts down before the next try", async () => {
    const lock = lockAnswering(() => ({ status: 429, body: { error: "Too many tries.", retryAfterMs: 30_000 } }));
    await lock.refresh();
    render(<PinPad lock={lock} view={lock.view()} onRemoved={() => undefined} />);
    for (const d of ["1", "1", "1", "1"]) fireEvent.click(screen.getByText(d));
    await settle();
    expect(screen.getByText(/Try again in 30 s/)).toBeTruthy();
  });

  it("is a sheet with Cancel for one sensitive action", () => {
    const lock = lockAnswering(() => ({ status: 200, body: {} }));
    render(<PinPad lock={lock} view={{ state: null, screen: false, prompt: true, removed: false }} onRemoved={() => undefined} />);
    expect(screen.getByText("Enter your PIN")).toBeTruthy();
    expect(screen.getByText("Unlock")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("tells a removed phone to pair again", () => {
    const removed = vi.fn();
    render(<PinPad lock={lockAnswering(() => ({ status: 200, body: {} }))} view={{ state: null, screen: true, prompt: false, removed: true }} onRemoved={removed} />);
    fireEvent.click(screen.getByText("Pair again"));
    expect(removed).toHaveBeenCalled();
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
