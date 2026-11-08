/**
 * With the soft keyboard up, the whole composer sits on it: the chat's
 * KeyboardAvoidingView measures where it is on screen (it sits under the
 * app's header, which a bare padding behaviour does not know), the box drops
 * to its least height whatever height was dragged, and the row of attach,
 * model, ring and Send stays inside the composer above the keys.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { MIN_HEIGHT, MIN_TRANSCRIPT } from "@ue-mcp-studio/client-core";
import { COMPOSER_CHROME, Composer } from "../src/chat/Composer";
import { Chat } from "../src/views/Chat";
import { setKeyboardHeight } from "../src/native/keyboard.web";
import { setSafeAreaInsets } from "./mocks/safe-area";
import { fakeApi, renderInProject, settle } from "./helpers";
import { render } from "@testing-library/react";

const none = () => undefined;
const BAR = 48;

function Box({ height }: { height?: number }) {
  const [draft, setDraft] = useState("");
  return <Composer draft={draft} onDraft={setDraft} onBlur={none} placeholder="Ask" busy={false} canSend={!!draft} onSend={none} onStop={none} files={[]} onAddFiles={none} onRemoveFile={none} picker={null} height={height} />;
}

const boxHeight = () => parseFloat((screen.getByPlaceholderText("Ask") as HTMLElement).style.height);

describe("the composer with the keyboard up", () => {
  it("keeps a dragged height while the keyboard is down, and starts at its least height while it is up", () => {
    setSafeAreaInsets({ bottom: BAR });
    const { unmount } = render(<Box height={240} />);
    expect(boxHeight()).toBe(240);
    unmount();
    setKeyboardHeight(300);
    render(<Box height={240} />);
    expect(boxHeight()).toBe(MIN_HEIGHT);
    const composer = screen.getByTestId("composer");
    // On the keys: no navigation bar's height under it.
    expect(parseFloat(getComputedStyle(composer).paddingBottom)).toBe(10);
    const shell = screen.getByTestId("composer-shell");
    for (const name of ["Attach", "Send"]) expect(shell.contains(screen.getByRole("button", { name }))).toBe(true);
    expect(shell.contains(screen.getByPlaceholderText("Ask"))).toBe(true);
  });

  it("lifts the chat by where it sits on screen, so the whole composer clears the keys", async () => {
    const api = fakeApi();
    const at = "2026-11-07T12:00:00Z";
    api.sessions.mockResolvedValue({ sessions: [{ id: "s1", title: "Door", status: "idle", createdAt: at, updatedAt: at, waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 }] });
    api.settings.mockResolvedValue({ route: "key" });
    api.sessionSync.mockResolvedValue({ id: "s1", title: "Door", status: "idle", createdAt: at, updatedAt: at, transcript: [{ kind: "user", text: "Open it", at }], touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [] });
    renderInProject(<Chat initialSession="s1" />, api);
    await settle();
    await settle();
    const avoiding = screen.getByTestId("composer").closest("[data-automatic-offset]");
    expect(avoiding?.getAttribute("data-automatic-offset")).toBe("true");
  });
});

/** What the platform reports when it lays a view out at `height` dp. */
function layOut(el: Element, height: number) {
  const handler = (el as unknown as { __reactLayoutHandler?: (e: unknown) => void }).__reactLayoutHandler;
  if (!handler) throw new Error("no layout handler on the element");
  act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height } } }));
}

const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long draft about the core game loop.`).join("\n");

/** The hidden mirror the box is sized from: its text laid out `height` tall. */
function mirrorAt(height: number) {
  const hidden = screen.getByTestId("composer-shell").querySelector("[aria-hidden]")!;
  const text = [hidden, ...hidden.querySelectorAll("*")].find((el) => (el as unknown as { __reactLayoutHandler?: unknown }).__reactLayoutHandler)!;
  layOut(text, height);
}

function Long({ space, height, onHeight }: { space?: number | null; height?: number; onHeight?: (h: number | null) => void }) {
  const [draft, setDraft] = useState(LONG);
  return <Composer draft={draft} onDraft={setDraft} onBlur={none} placeholder="Ask" busy={false} canSend={!!draft} onSend={none} onStop={none} files={[]} onAddFiles={none} onRemoveFile={none} picker={null} space={space} height={height} onHeight={onHeight} />;
}

/** The bar stays in the composer under the box: Attach and Send are laid out, not pushed off. */
function barKept() {
  const shell = screen.getByTestId("composer-shell");
  const input = screen.getByPlaceholderText("Ask");
  for (const name of ["Attach", "Send"]) {
    const b = screen.getByRole("button", { name });
    expect(shell.contains(b)).toBe(true);
    expect(input.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
}

describe("a long draft", () => {
  it("with the keyboard down, grows to the room the chat leaves it, then scrolls inside it", () => {
    setSafeAreaInsets({ bottom: BAR });
    render(<Long space={600} />);
    mirrorAt(40 * 24 + 18);
    const cap = 600 - MIN_TRANSCRIPT - (COMPOSER_CHROME + BAR);
    expect(boxHeight()).toBe(cap);
    expect(getComputedStyle(screen.getByPlaceholderText("Ask")).overflowY).not.toBe("hidden");
    barKept();
  });

  it("with the keyboard up, stops at the room above the keys, so the bar stays on them", () => {
    setSafeAreaInsets({ bottom: BAR });
    setKeyboardHeight(300);
    render(<Long space={360} />);
    mirrorAt(40 * 24 + 18);
    // On the keys the navigation bar's inset is not the composer's.
    const cap = 360 - MIN_TRANSCRIPT - COMPOSER_CHROME;
    expect(boxHeight()).toBe(cap);
    expect(getComputedStyle(screen.getByPlaceholderText("Ask")).overflowY).not.toBe("hidden");
    barKept();
  });

  it("without a measured column, caps by the window less the keyboard and the status bar", () => {
    const root = document.documentElement;
    Object.defineProperty(root, "clientHeight", { value: 860, configurable: true });
    act(() => void window.dispatchEvent(new Event("resize")));
    try {
      setSafeAreaInsets({ top: 24 });
      setKeyboardHeight(300);
      render(<Long />);
      mirrorAt(40 * 24 + 18);
      expect(boxHeight()).toBe(860 - 300 - 24 - MIN_TRANSCRIPT - COMPOSER_CHROME);
    } finally {
      delete (root as unknown as { clientHeight?: number }).clientHeight;
      act(() => void window.dispatchEvent(new Event("resize")));
    }
  });

  it("counts what the composer measures besides the box, such as attached files", () => {
    render(<Long space={700} />);
    mirrorAt(40 * 24 + 18);
    layOut(screen.getByTestId("composer"), 500);
    layOut(screen.getByPlaceholderText("Ask"), 200);
    expect(boxHeight()).toBe(700 - MIN_TRANSCRIPT - 300);
  });

  it("caps a dragged height, and the handle never saves one past the cap", () => {
    vi.useFakeTimers();
    try {
      const onHeight = vi.fn();
      setSafeAreaInsets({ bottom: BAR });
      render(<Long space={600} height={5000} onHeight={onHeight} />);
      const cap = 600 - MIN_TRANSCRIPT - (COMPOSER_CHROME + BAR);
      expect(boxHeight()).toBe(cap);
      const handle = screen.getByLabelText("Resize the message box");
      fireEvent.keyDown(handle, { key: "ArrowUp" });
      act(() => void vi.advanceTimersByTime(1000));
      expect(onHeight).toHaveBeenLastCalledWith(cap);
    } finally {
      vi.useRealTimers();
    }
  });

  it("in the chat, takes its room from the column under the header less the cards", async () => {
    const api = fakeApi();
    const at = "2026-11-07T12:00:00Z";
    api.sessions.mockResolvedValue({ sessions: [{ id: "s1", title: "Door", status: "idle", createdAt: at, updatedAt: at, waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 }] });
    api.settings.mockResolvedValue({ route: "key" });
    api.sessionSync.mockResolvedValue({ id: "s1", title: "Door", status: "idle", createdAt: at, updatedAt: at, transcript: [{ kind: "user", text: "Open it", at }], touched: [], draft: LONG, seen: [], dismissed: [], queue: [], error: null, approvals: [] });
    setKeyboardHeight(300);
    renderInProject(<Chat initialSession="s1" />, api);
    await settle();
    await settle();
    const input = screen.getByTestId("composer-shell").querySelector("textarea:not([aria-hidden])") as HTMLElement;
    const hidden = screen.getByTestId("composer-shell").querySelector("[aria-hidden]")!;
    const text = [hidden, ...hidden.querySelectorAll("*")].find((el) => (el as unknown as { __reactLayoutHandler?: unknown }).__reactLayoutHandler)!;
    layOut(text, 40 * 24 + 18);
    layOut(screen.getByTestId("chat-column"), 420);
    layOut(screen.getByTestId("chat-cards"), 40);
    expect(parseFloat(input.style.height)).toBe(420 - 40 - MIN_TRANSCRIPT - COMPOSER_CHROME);
  });
});
