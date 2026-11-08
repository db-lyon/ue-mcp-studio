// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ unlockWith: vi.fn(), cancelPrompt: vi.fn(), view: { screen: true, prompt: false, removed: false, state: null as null | Record<string, unknown> } }));
vi.mock("../../remote-lock", () => ({
  lockView: () => m.view,
  subscribeLock: () => () => {},
  unlockWith: m.unlockWith,
  cancelPrompt: m.cancelPrompt,
  installLockGuard: () => {},
  refreshLock: async () => null,
}));
import { LockScreen, PinSheet } from "./RemoteLock";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  m.view = { screen: true, prompt: false, removed: false, state: null };
});

const key = (name: string) => screen.getByRole("button", { name });
const filled = () => document.querySelectorAll(".pin-dot.on").length;

describe("the remote PIN keypad", () => {
  it("has no text field, so the device keyboard never opens", () => {
    render(<LockScreen />);
    expect(document.querySelector("input")).toBeNull();
    for (const d of "0123456789") expect(key(d)).toBeTruthy();
  });

  it("drops the focus of a text box under it when it shows and when the page comes back, so a phone's keyboard goes away", () => {
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    try {
      box.focus();
      expect(document.activeElement).toBe(box);
      render(<LockScreen />);
      expect(document.activeElement).not.toBe(box);
      box.focus();
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      expect(document.activeElement).not.toBe(box);
      cleanup();
      box.focus();
      render(<PinSheet />);
      expect(document.activeElement).not.toBe(box);
    } finally {
      box.remove();
    }
  });

  it("fills a dot per digit, deletes, and enables enter at four digits", async () => {
    m.unlockWith.mockResolvedValue({ ok: true });
    render(<LockScreen />);
    for (const d of "123") fireEvent.click(key(d));
    expect(filled()).toBe(3);
    expect((key("Unlock") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(key("Delete"));
    expect(filled()).toBe(2);
    fireEvent.click(key("3"));
    fireEvent.click(key("4"));
    await act(async () => void fireEvent.click(key("Unlock")));
    expect(m.unlockWith).toHaveBeenCalledWith("1234");
  });

  it("stops at eight digits", () => {
    render(<LockScreen />);
    for (const d of "1234567890") fireEvent.click(key(d));
    expect(filled()).toBe(8);
  });

  it("takes digits, Backspace and Enter from a hardware keyboard", async () => {
    m.unlockWith.mockResolvedValue({ ok: true });
    render(<LockScreen />);
    for (const k of ["9", "8", "7", "6", "5", "Backspace", "Enter"]) fireEvent.keyDown(window, { key: k });
    await act(async () => {});
    expect(m.unlockWith).toHaveBeenCalledWith("9876");
  });

  it("clears the dots and shows the error on a wrong PIN", async () => {
    m.unlockWith.mockResolvedValue({ ok: false, error: "Wrong PIN." });
    render(<LockScreen />);
    for (const d of "1111") fireEvent.click(key(d));
    await act(async () => void fireEvent.click(key("Unlock")));
    expect(filled()).toBe(0);
    expect(screen.getByRole("alert").textContent).toContain("Wrong PIN.");
  });

  it("the sensitive-action sheet uses the same pad with Continue and Cancel", () => {
    render(<PinSheet />);
    expect(document.querySelector("input")).toBeNull();
    expect(key("Continue")).toBeTruthy();
    fireEvent.click(key("Cancel"));
    expect(m.cancelPrompt).toHaveBeenCalled();
  });
});

describe("the keypad when the computer knows the PIN's length", () => {
  const known = (pinLength: number) => {
    m.view = { screen: true, prompt: false, removed: false, state: { whole: true, sensitive: false, locked: true, sensitiveOpen: true, idleMinutes: 15, pinLength } };
  };

  it("shows one dot per digit, has no enter key, and submits on the last digit", async () => {
    known(6);
    m.unlockWith.mockResolvedValue({ ok: true });
    render(<LockScreen />);
    expect(document.querySelectorAll(".pin-dot").length).toBe(6);
    expect(screen.queryByRole("button", { name: "Unlock" })).toBeNull();
    for (const d of "48291") fireEvent.click(key(d));
    expect(m.unlockWith).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(key("5")));
    expect(m.unlockWith).toHaveBeenCalledWith("482915");
  });

  it("submits from a hardware keyboard on the last digit too, and ignores Enter", async () => {
    known(4);
    m.unlockWith.mockResolvedValue({ ok: true });
    render(<LockScreen />);
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(m.unlockWith).not.toHaveBeenCalled();
    for (const k of ["2", "3", "4"]) fireEvent.keyDown(window, { key: k });
    await act(async () => {});
    expect(m.unlockWith).toHaveBeenCalledTimes(1);
    expect(m.unlockWith).toHaveBeenCalledWith("1234");
  });
});
