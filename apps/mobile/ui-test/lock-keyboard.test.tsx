/**
 * The soft keyboard never shows over the PIN lock: a text box left focused
 * under it (the composer, with the keyboard up when the app locked) loses the
 * focus when the lock appears, again when the app comes back to the front,
 * and the lock itself holds no text box.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AppState, Keyboard, TextInput, View } from "react-native";
import { createLock, type Transport } from "@ue-mcp-studio/client-core";
import { RemoteLock } from "../src/views/remote/RemoteLock";
import { settle } from "./helpers";

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});
const state = { locked: false };
const computer: Transport = async (_method, path) => {
  if (path === "/v1/ext/studio/lock") return json(200, { whole: true, sensitive: true, locked: state.locked, sensitiveOpen: false, idleMinutes: 10, pinLength: 4 });
  return json(200, {});
};

function App({ lock }: { lock: ReturnType<typeof createLock> }) {
  const [draft, setDraft] = useState("A long draft");
  return (
    <View style={{ flex: 1 }}>
      <TextInput testID="box" multiline value={draft} onChangeText={setDraft} />
      <RemoteLock lock={lock} computerKey="k" />
    </View>
  );
}

const box = () => screen.getByTestId("box") as HTMLElement;

describe("the PIN lock and the soft keyboard", () => {
  it("drops the focus of a text box under it when it appears, and holds none of its own", async () => {
    const dismiss = vi.spyOn(Keyboard, "dismiss");
    const lock = createLock(computer);
    render(<App lock={lock} />);
    await settle();
    act(() => box().focus());
    expect(document.activeElement).toBe(box());
    state.locked = true;
    await act(async () => void (await lock.refresh()));
    await settle();
    expect(screen.getByText("Studio is locked")).toBeTruthy();
    expect(document.activeElement).not.toBe(box());
    expect(dismiss).toHaveBeenCalled();
    const lockScreen = screen.getByLabelText("Studio is locked");
    expect(lockScreen.querySelector("input, textarea, [contenteditable]")).toBeNull();
    state.locked = false;
    dismiss.mockRestore();
  });

  it("puts the keyboard away again when the app comes back to the front, or the keyboard shows, while locked", async () => {
    const changes: ((s: string) => void)[] = [];
    const shows: (() => void)[] = [];
    const app = vi.spyOn(AppState, "addEventListener").mockImplementation(((_t: string, h: (s: string) => void) => (changes.push(h), { remove: () => undefined })) as never);
    const kb = vi.spyOn(Keyboard, "addListener").mockImplementation(((_t: string, h: () => void) => (shows.push(h), { remove: () => undefined })) as never);
    try {
      state.locked = true;
      const lock = createLock(computer);
      await act(async () => void (await lock.refresh()));
      render(<App lock={lock} />);
      await settle();
      expect(screen.getByText("Studio is locked")).toBeTruthy();
      expect(changes.length).toBeGreaterThan(0);
      expect(shows.length).toBeGreaterThan(0);
      // Android hands the focus back to the box as the app returns.
      act(() => box().focus());
      act(() => changes.forEach((h) => h("active")));
      expect(document.activeElement).not.toBe(box());
      act(() => box().focus());
      act(() => shows.forEach((h) => h()));
      expect(document.activeElement).not.toBe(box());
    } finally {
      state.locked = false;
      app.mockRestore();
      kb.mockRestore();
    }
  });
});
