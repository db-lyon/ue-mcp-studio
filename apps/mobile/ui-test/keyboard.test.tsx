/**
 * With the soft keyboard up, the whole composer sits on it: the chat's
 * KeyboardAvoidingView measures where it is on screen (it sits under the
 * app's header, which a bare padding behaviour does not know), the box drops
 * to its least height whatever height was dragged, and the row of attach,
 * model, ring and Send stays inside the composer above the keys.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MIN_HEIGHT } from "@ue-mcp-studio/client-core";
import { Composer } from "../src/chat/Composer";
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
