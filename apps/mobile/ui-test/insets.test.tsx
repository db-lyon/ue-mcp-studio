/**
 * The app draws edge to edge: on a phone with 3-button navigation (a 48 px
 * bottom inset) every surface that reaches the bottom of the screen must end
 * above the bar, and above the keyboard instead while it is up. jsdom has no
 * layout, so these read the padding each surface keeps between its content
 * and the bottom of the screen.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createLock } from "@ue-mcp-studio/client-core";
import { setSafeAreaInsets } from "./mocks/safe-area";
import { setKeyboardHeight } from "../src/native/keyboard.web";
import { Button, Sheet } from "../src/ui";
import { LockScreen, PinSheet, RememberOffer } from "../src/views/remote/RemoteLock";
import { Composer } from "../src/chat/Composer";
import { NavDrawer } from "../src/views/NavDrawer";
import { ConnectionOverlay } from "../src/views/ConnectionOverlay";
import { UpdateScreen, UpdateWaiting } from "../src/views/UpdateOverlay";
import { RefusedScreen } from "../src/views/Refused";
import { Chat } from "../src/views/Chat";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen";
import { PluginsScreen } from "../src/screens/plugins/PluginsScreen";
import { PlaytestsView } from "../src/screens/playtests/Playtests";
import { FeedbackSheet } from "../src/screens/feedback/FeedbackSheet";
import { ChangesSheet } from "../src/screens/git/ChangesSheet";
import { Welcome, Pairing } from "../src/screens/Pairing";
import { Projects } from "../src/screens/Projects";
import { Scanner } from "../src/screens/Scanner";
import { About } from "../src/screens/About";
import { Harness } from "../visual-qa/harness";
import type { DaemonState } from "../src/state";
import type { Transport } from "@ue-mcp-studio/client-core";
import { fakeApi, renderInProject, session, settle } from "./helpers";

const BAR = 48;
const px = (el: Element, side: "paddingBottom" | "paddingTop" | "paddingLeft" | "marginBottom") => parseFloat(getComputedStyle(el)[side]);
const none = () => undefined;
const bio = { available: true, enabled: false, unlock: async () => null, remember: async () => undefined, forget: async () => undefined };
const daemon = (over: Partial<DaemonState> = {}): DaemonState => ({ health: null, error: null, streaming: true, events: [], refresh: none, ...over });
const lockAt = (state: Record<string, unknown>) => {
  const t: Transport = async () => ({ status: 200, headers: { "content-type": "application/json" }, body: (async function* () { yield new TextEncoder().encode(JSON.stringify(state)); })() });
  return createLock(t);
};

/** The composer with its draft kept, as views/Chat.tsx keeps it. */
function Box() {
  const [draft, setDraft] = useState("");
  return <Composer draft={draft} onDraft={setDraft} onBlur={none} placeholder="Ask" busy={false} canSend={!!draft} onSend={none} onStop={none} files={[]} onAddFiles={none} onRemoveFile={none} picker={null} />;
}

describe("the shell on a phone with a 48 px navigation bar", () => {
  it("ends the composer above the bar in the real shell", async () => {
    setSafeAreaInsets({ top: 0, bottom: BAR });
    render(<Harness name="composer-idle" theme="ue-mcp" />);
    for (let i = 0; i < 12 && !screen.queryByTestId("composer"); i++) await settle();
    const composer = screen.getByTestId("composer");
    expect(px(composer, "paddingBottom")).toBe(10 + BAR);
    // Its send button is inside that padding's top edge: nothing of it reaches into the bar.
    expect(composer.contains(screen.getByLabelText("Send"))).toBe(true);
  });

  it("lifts the composer onto the keyboard while it is up, dropping the bar's inset", () => {
    setSafeAreaInsets({ bottom: BAR });
    setKeyboardHeight(300);
    render(<Box />);
    expect(px(screen.getByTestId("composer"), "paddingBottom")).toBe(10);
  });

  it("keeps the src/ui Sheet's actions above the bar, and above the keyboard while it is up", () => {
    setSafeAreaInsets({ bottom: BAR, left: 20, right: 20 });
    const { unmount } = render(
      <Sheet open title="Checkpoints" onClose={none}>
        <Button title="Restore" onPress={none} />
      </Sheet>,
    );
    const sheet = screen.getByLabelText("Checkpoints");
    expect(sheet.contains(screen.getByText("Restore"))).toBe(true);
    expect(px(sheet, "paddingBottom")).toBe(12 + BAR);
    expect(px(sheet, "paddingLeft")).toBe(10 + 20);
    unmount();
    setKeyboardHeight(300);
    render(
      <Sheet open title="Checkpoints" onClose={none}>
        <Button title="Restore" onPress={none} />
      </Sheet>,
    );
    expect(px(screen.getByLabelText("Checkpoints"), "paddingBottom")).toBe(12 + 300);
  });

  it("keeps the fingerprint offer's buttons above the bar", () => {
    setSafeAreaInsets({ bottom: BAR });
    render(<RememberOffer onYes={none} onNo={none} />);
    const sheet = screen.getAllByLabelText("Use fingerprint next time").find((el) => el.getAttribute("role") !== "button")!;
    expect(sheet.contains(screen.getByRole("button", { name: "Use fingerprint next time" }))).toBe(true);
    expect(sheet.contains(screen.getByText("Not now"))).toBe(true);
    expect(px(sheet, "paddingBottom")).toBe(16 + BAR);
  });

  it("keeps the PIN sheet's keypad and the lock screen's above the bar and below the status bar", async () => {
    setSafeAreaInsets({ top: 30, bottom: BAR });
    const lock = lockAt({ whole: true, sensitive: true, locked: true, sensitiveOpen: false, idleMinutes: 10, pinLength: 4 });
    await lock.refresh();
    const { unmount } = render(<PinSheet lock={lock} bio={bio} onUnlocked={none} />);
    expect(px(screen.getByLabelText("Enter your PIN"), "paddingBottom")).toBe(16 + BAR);
    unmount();
    render(<LockScreen lock={lock} bio={bio} onUnlocked={none} />);
    const screenEl = screen.getByLabelText("Studio is locked");
    expect(px(screenEl, "paddingBottom")).toBe(16 + BAR);
    expect(px(screenEl, "paddingTop")).toBe(16 + 30);
  });

  it("pads the drawer by both bars", () => {
    setSafeAreaInsets({ top: 30, bottom: BAR });
    renderInProject(<NavDrawer open onClose={none} tab="Chat" session={null} updates={0} playtestsWaiting={0} onTab={none} onSession={none} onNewSession={none} />);
    const drawer = screen.getByLabelText("Navigation");
    expect(px(drawer, "paddingTop")).toBe(10 + 30);
    expect(px(drawer, "paddingBottom")).toBe(10 + BAR);
  });

  it("centres the connection and update overlays between the bars, and ends the update banner above the bar", () => {
    setSafeAreaInsets({ top: 30, bottom: BAR });
    const conn = { conn: { phase: "lost", downSince: Date.now() - 60_000, why: "The relay lost the computer" }, now: Date.now(), log: "", remote: true, retry: none } as never;
    const { unmount } = renderInProject(<ConnectionOverlay c={conn} />);
    const overlay = screen.getByTestId("connection-overlay");
    expect(px(overlay, "paddingBottom")).toBe(8 + BAR);
    expect(px(overlay, "paddingTop")).toBe(8 + 30);
    unmount();
    const run = { id: "r", startedAt: "", steps: [{ key: "agent", state: "active" }], summary: undefined } as never;
    const u = renderInProject(<UpdateScreen run={run} slow={false} onClose={none} />);
    expect(px(screen.getByLabelText("Updating"), "paddingBottom")).toBe(8 + BAR);
    expect(px(screen.getByLabelText("Updating"), "paddingTop")).toBe(8 + 30);
    u.unmount();
    renderInProject(<UpdateWaiting run={{ id: "r", startedAt: "", steps: [{ key: "agent", state: "waiting" }] } as never} />);
    // The banner around Restart now: the nearest box with a bottom margin.
    let banner: HTMLElement | null = screen.getByText("Restart now");
    while (banner && !px(banner, "marginBottom")) banner = banner.parentElement;
    expect(banner && px(banner, "marginBottom")).toBe(6 + BAR);
  });

  it("pads the refusal page by both bars", () => {
    setSafeAreaInsets({ top: 30, bottom: BAR });
    renderInProject(<RefusedScreen refusal={{ needs: "1.5.0", have: "1.4.0" } as never} />);
    const main = screen.getByRole("heading").parentElement!.parentElement!;
    expect(px(main, "paddingBottom")).toBe(6 + BAR);
    expect(px(main, "paddingTop")).toBe(6 + 30);
  });
});

describe("pages scroll their end clear of the bar", () => {
  const content = (testID: string) => screen.getByTestId(testID).firstElementChild!;

  it("the session list and the empty session page", async () => {
    setSafeAreaInsets({ bottom: BAR });
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [session()] });
    api.settings.mockResolvedValue({ provider: "anthropic", model: "m", effort: "medium", route: "key", connected: true });
    api.models.mockResolvedValue({ signedIn: {}, providers: [] });
    const { unmount } = renderInProject(<Chat />, api);
    await settle();
    expect(px(content("sessions"), "paddingBottom")).toBe(10 + BAR);
    unmount();
    api.sessions.mockResolvedValue({ sessions: [] });
    renderInProject(<Chat />, api);
    await settle();
    expect(px(content("chat-empty"), "paddingBottom")).toBe(28 + BAR);
  });

  it("Settings, Plugins and Playtests, and the keyboard's height while it is up", async () => {
    setSafeAreaInsets({ bottom: BAR });
    const s = renderInProject(<SettingsScreen daemon={daemon()} section={null} onSection={none} onTheme={none} />);
    expect(px(content("settings"), "paddingBottom")).toBe(6 + BAR);
    s.unmount();
    const p = renderInProject(<PluginsScreen daemon={daemon()} />);
    expect(px(content("plugins"), "paddingBottom")).toBe(6 + BAR);
    p.unmount();
    renderInProject(<PlaytestsView daemon={daemon()} index={{ index: null, error: null, reload: none }} onOpenSession={none} />);
    expect(px(content("playtests-page"), "paddingBottom")).toBe(18 + BAR);
    setKeyboardHeight(280);
    await settle();
    expect(px(content("playtests-page"), "paddingBottom")).toBe(18 + 280);
  });

  it("the pairing, projects and about pages, and the scanner's foot", async () => {
    setSafeAreaInsets({ top: 24, bottom: BAR });
    // A page without a footer ends the relay stage's 24 above the bar.
    const w = render(<Welcome onScan={none} onLink={none} />);
    expect(px(content("page"), "paddingBottom")).toBe(24 + BAR);
    w.unmount();
    const c = render(<Pairing step={{ kind: "code", code: "123456" }} />);
    expect(px(content("page"), "paddingBottom")).toBe(24 + BAR);
    c.unmount();
    const pr = render(<Projects onOpen={none} onPair={none} onSettings={none} onUnpaired={none} />);
    const foot = screen.getByTestId("page-footer");
    expect(foot.contains(screen.getByText("Pair another computer"))).toBe(true);
    expect(px(foot, "paddingBottom")).toBe(16 + BAR);
    await settle();
    pr.unmount();
    const sc = render(<Scanner onCode={none} onCancel={none} />);
    await settle();
    const scanFoot = screen.getByTestId("scanner-foot");
    expect(scanFoot.contains(screen.getByText("Scan from a picture"))).toBe(true);
    expect(px(scanFoot, "paddingBottom")).toBe(16 + BAR);
    sc.unmount();
    render(<About onBack={none} />);
    expect(px(content("page"), "paddingBottom")).toBe(24 + BAR);
  });
});

describe("dialogs drawn in their own Modal window", () => {
  it("the feedback dialog stays clear of both bars, and of the keyboard while it is up", () => {
    setSafeAreaInsets({ top: 30, bottom: BAR });
    const { unmount } = renderInProject(<FeedbackSheet onClose={none} />);
    const backdrop = screen.getAllByLabelText("Close")[0];
    expect(px(backdrop, "paddingBottom")).toBe(8 + BAR);
    expect(px(backdrop, "paddingTop")).toBe(8 + 30);
    unmount();
    setKeyboardHeight(300);
    renderInProject(<FeedbackSheet onClose={none} />);
    expect(px(screen.getAllByLabelText("Close")[0], "paddingBottom")).toBe(8 + 300);
  });

  it("the changes sheet keeps clear of both bars", () => {
    setSafeAreaInsets({ top: 30, bottom: BAR });
    const api = fakeApi();
    api.vcsChanges.mockResolvedValue({ changes: [], truncated: false });
    renderInProject(<ChangesSheet vcs={{ kind: "git", branch: "main", changed: 0 } as never} onClose={none} />, api);
    const backdrop = screen.getByTestId("changes-panel").parentElement!;
    expect(px(backdrop, "paddingBottom")).toBe(8 + BAR);
    expect(px(backdrop, "paddingTop")).toBe(8 + 30);
  });
});
