// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  remoteLock: vi.fn(),
  setRemotePin: vi.fn(),
  removeRemotePin: vi.fn(),
  setRemoteLock: vi.fn(),
}));
const e = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("../../api", () => ({ api: m, ApiError: e.ApiError, notThere: (x: unknown) => x instanceof e.ApiError && x.status === 404 }));
import { PinLockCard } from "./PinLockCard";

const OFF = { pin: false, whole: false, sensitive: false, idleMinutes: 15 };
const SET = { pin: true, whole: false, sensitive: false, idleMinutes: 15 };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function show(lock: unknown) {
  m.remoteLock.mockResolvedValue(lock);
  await act(async () => void render(<PinLockCard />));
}

describe("Settings > Remote control > PIN lock", () => {
  it("is off until a PIN is set; setting one asks twice, digits only", async () => {
    await show(OFF);
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set a PIN" }));
    const [pin, again] = screen.getAllByDisplayValue("") as HTMLInputElement[];
    expect(pin.getAttribute("inputmode")).toBe("numeric");
    fireEvent.change(pin, { target: { value: "48a21" } });
    expect(pin.value).toBe("4821");
    fireEvent.change(again, { target: { value: "4822" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Set PIN" })));
    expect(screen.getByRole("alert").textContent).toBe("The two PINs differ.");
    expect(m.setRemotePin).not.toHaveBeenCalled();
    fireEvent.change(again, { target: { value: "4821" } });
    m.setRemotePin.mockResolvedValue(SET);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Set PIN" })));
    expect(m.setRemotePin).toHaveBeenCalledWith("4821");
    expect(screen.getByRole("switch", { name: "Lock Studio on paired devices" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Ask for sensitive actions" })).toBeTruthy();
  });

  it("either switch, or both; the idle time shows once Studio locks on paired devices", async () => {
    await show(SET);
    expect(screen.queryByRole("radiogroup", { name: "Lock again after" })).toBeNull();
    m.setRemoteLock.mockResolvedValue({ ...SET, whole: true });
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Lock Studio on paired devices" })));
    expect(m.setRemoteLock).toHaveBeenCalledWith({ whole: true });
    expect(screen.getByRole("radiogroup", { name: "Lock again after" })).toBeTruthy();
    m.setRemoteLock.mockResolvedValue({ ...SET, whole: true, idleMinutes: 5 });
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "5 min" })));
    expect(m.setRemoteLock).toHaveBeenLastCalledWith({ idleMinutes: 5 });
    m.setRemoteLock.mockResolvedValue({ ...SET, whole: true, sensitive: true, idleMinutes: 5 });
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Ask for sensitive actions" })));
    expect(m.setRemoteLock).toHaveBeenLastCalledWith({ sensitive: true });
    expect(screen.getByRole("switch", { name: "Ask for sensitive actions" }).getAttribute("aria-checked")).toBe("true");
  });

  it("Remove PIN turns both switches off", async () => {
    await show({ ...SET, whole: true, sensitive: true });
    m.removeRemotePin.mockResolvedValue(OFF);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Remove PIN" })));
    expect(m.removeRemotePin).toHaveBeenCalled();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: "Set a PIN" })).toBeTruthy();
  });

  it("an agent without the lock leaves the card out", async () => {
    m.remoteLock.mockRejectedValue(new e.ApiError(404, "Not found."));
    const { container } = await act(async () => render(<PinLockCard />));
    expect(container.textContent).toBe("");
  });
});
