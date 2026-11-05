// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  remoteLock: vi.fn(),
  setRemotePin: vi.fn(),
  removeRemotePin: vi.fn(),
  setRemoteLock: vi.fn(),
  forgetRemotePin: vi.fn(),
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
    expect(m.setRemotePin).toHaveBeenCalledWith("4821", undefined);
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

  const typeCurrent = (v: string) => fireEvent.change(screen.getByLabelText("Current PIN"), { target: { value: v } });

  it("Remove PIN asks for the current PIN; a wrong one stays and says so", async () => {
    await show({ ...SET, whole: true, sensitive: true });
    fireEvent.click(screen.getByRole("button", { name: "Remove PIN" }));
    expect(m.removeRemotePin).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove PIN" }).hasAttribute("disabled")).toBe(true);
    m.removeRemotePin.mockRejectedValueOnce(new e.ApiError(401, "The current PIN is wrong."));
    typeCurrent("0000");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Remove PIN" })));
    expect(m.removeRemotePin).toHaveBeenCalledWith("0000");
    expect(screen.getByRole("alert").textContent).toBe("The current PIN is wrong.");
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    m.removeRemotePin.mockResolvedValue(OFF);
    typeCurrent("4821");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Remove PIN" })));
    expect(m.removeRemotePin).toHaveBeenLastCalledWith("4821");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: "Set a PIN" })).toBeTruthy();
  });

  it("Change PIN takes the current PIN and the new one twice", async () => {
    await show(SET);
    fireEvent.click(screen.getByRole("button", { name: "Change PIN" }));
    const [current, pin, again] = ["Current PIN", "New PIN", "New PIN again"].map((l) => screen.getByLabelText(l));
    fireEvent.change(pin, { target: { value: "1111" } });
    fireEvent.change(again, { target: { value: "1111" } });
    expect(screen.getByRole("button", { name: "Change PIN" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(current, { target: { value: "4821" } });
    m.setRemotePin.mockResolvedValue(SET);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Change PIN" })));
    expect(m.setRemotePin).toHaveBeenCalledWith("1111", "4821");
    expect(screen.queryByLabelText("Current PIN")).toBeNull();
  });

  it("a switch off or a longer idle time waits for the current PIN; on and shorter do not", async () => {
    await show({ ...SET, whole: true, sensitive: true, idleMinutes: 15 });
    fireEvent.click(screen.getByRole("switch", { name: "Ask for sensitive actions" }));
    expect(m.setRemoteLock).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the current PIN to stop asking for sensitive actions.")).toBeTruthy();
    m.setRemoteLock.mockResolvedValue({ ...SET, whole: true, sensitive: false });
    typeCurrent("4821");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Turn off" })));
    expect(m.setRemoteLock).toHaveBeenCalledWith({ sensitive: false, current: "4821" });
    expect(screen.getByRole("switch", { name: "Ask for sensitive actions" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("radio", { name: "1 hour" }));
    expect(screen.getByText("Enter the current PIN to lock again after 1 hour instead of 15 min.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(m.setRemoteLock).toHaveBeenCalledTimes(1);

    m.setRemoteLock.mockResolvedValue({ ...SET, whole: true, sensitive: false, idleMinutes: 5 });
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "5 min" })));
    expect(m.setRemoteLock).toHaveBeenLastCalledWith({ idleMinutes: 5 });

    fireEvent.click(screen.getByRole("switch", { name: "Lock Studio on paired devices" }));
    expect(screen.getByText("Enter the current PIN to stop locking Studio on paired devices.")).toBeTruthy();
  });

  it("Forgot PIN confirms that every paired device goes, then resets and reloads the list", async () => {
    const onUnpaired = vi.fn();
    m.remoteLock.mockResolvedValue({ ...SET, whole: true });
    await act(async () => void render(<PinLockCard onUnpaired={onUnpaired} />));
    fireEvent.click(screen.getByRole("button", { name: "Forgot PIN" }));
    expect(screen.getByRole("group", { name: "Forgot PIN" }).textContent).toContain("This removes every paired phone and browser; pair them again afterwards.");
    expect(m.forgetRemotePin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(m.forgetRemotePin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Forgot PIN" }));
    m.forgetRemotePin.mockResolvedValue({ ...OFF, unpaired: 2 });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Remove PIN and unpair all" })));
    expect(m.forgetRemotePin).toHaveBeenCalled();
    expect(onUnpaired).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Set a PIN" })).toBeTruthy();
  });

  it("states the rule once a PIN is set", async () => {
    await show(SET);
    expect(screen.getByText(/needs the current PIN, here too/)).toBeTruthy();
  });

  it("an agent without the lock leaves the card out", async () => {
    m.remoteLock.mockRejectedValue(new e.ApiError(404, "Not found."));
    const { container } = await act(async () => render(<PinLockCard />));
    expect(container.textContent).toBe("");
  });
});
