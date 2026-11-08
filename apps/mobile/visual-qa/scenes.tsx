/**
 * The app's own screens that no web scenario draws (pairing, the scanner,
 * projects, paired devices, About, and the banners and prompts only the phone
 * has), each in one state, for scripts/parity-mobile.mjs --scenes to shoot at
 * 390 by 844 in every theme: ?scene=<name>&theme=<theme>. The relay and the
 * native modules are the ui-test mocks, set up per scene before it draws.
 */
import { useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Transport } from "@ue-mcp-studio/client-core";
import type { StudioTheme, TranscriptEntry } from "@ue-mcp-studio/shared";
import type { Scenario } from "../../client-web/src/visual-qa/fixtures";
import { longReply } from "./long-reply";
import { SCENARIOS, scenarioTransport } from "./harness";
import { store } from "../ui-test/mocks/secure-store";
import { clip } from "../ui-test/mocks/clipboard";
import { picked } from "../ui-test/mocks/image-picker";
import { RELAY, type Device, type Viewer } from "../src/relay";
import { Welcome, Pairing, Paired, PairFailed, type PairFailure } from "../src/screens/Pairing";
import { Scanner } from "../src/screens/Scanner";
import { Projects } from "../src/screens/Projects";
import { Settings } from "../src/screens/Settings";
import { About } from "../src/screens/About";
import { ProjectScreen } from "../src/screens/Project";
import { OfflineBanner } from "../src/views/OfflineBanner";
import { RememberOffer } from "../src/views/remote/RemoteLock";
import { THEMES, ThemeProvider, useStudioFonts, useTheme } from "../src/ui";
import { setKeyboardHeight } from "../src/native/keyboard.web";

const g = globalThis as Record<string, unknown>;
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const DEVICES: Device[] = [
  { id: "d1", name: "Vale", online: true, computerKey: "keyA", lastSeen: ago(0) },
  { id: "d2", name: "Lumen Run", online: true, computerKey: "keyA", lastSeen: ago(0) },
  { id: "d3", name: "POLYGON", online: true, computerKey: "keyB", lastSeen: ago(0) },
  { id: "d4", name: "StudioE2E", online: false, computerKey: "keyA", lastSeen: ago(185) },
];
const VIEWERS: Viewer[] = [
  { id: "v1", label: "Android (Studio app)", createdAt: "2026-11-01T10:00:00Z", current: true },
  { id: "v2", label: "Windows (Edge)", createdAt: "2026-10-12T10:00:00Z", current: false },
  { id: "v3", label: "iPad (Safari)", createdAt: "2026-09-30T10:00:00Z", current: false },
];

/** The relay's /api/devices as the scene needs it: an answer, an error status, or none at all. */
function relay(answer: { devices?: Device[]; viewers?: Viewer[]; status?: number; hang?: boolean }) {
  const real = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(RELAY)) return real(input, init);
    if (answer.hang) return new Promise<Response>(() => undefined);
    const status = answer.status ?? 200;
    const body = status === 200 ? { devices: answer.devices ?? DEVICES, viewers: answer.viewers ?? VIEWERS } : { error: "The relay is restarting. Try again in a minute." };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function pairedWith(keys: string[], last?: Device) {
  store.set("trusted", JSON.stringify(Object.fromEntries(keys.map((k) => [k, { pairedAt: "2026-10-20T10:00:00Z" }]))));
  if (last) store.set("selected", JSON.stringify(last));
}

/** A health answer from a computer whose Studio is `studio`. */
const healthOf = (studio: string): Transport => async () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify({ version: "1.4.12", extensions: [{ name: "studio", version: studio }] }));
  })(),
});
const unreachable: Transport = async () => {
  throw new Error("offline");
};

const none = () => undefined;
const failed = (kind: PairFailure["kind"], message = ""): ReactNode => <PairFailed failure={{ kind, message }} onScan={none} onStart={none} onRetry={none} />;

/** A web scenario's project, the phone's way, with what the scene changes about it. */
function InProject({ name, hash, transport, children, scenario: given }: { name: string; hash?: string; transport?: (base: Transport) => Transport; children?: ReactNode; scenario?: Scenario }) {
  const scenario = given ?? SCENARIOS[name];
  const theme = useTheme().name;
  const t = useMemo(() => {
    const base = scenarioTransport(hash ? { ...scenario, hash } : scenario, theme);
    return transport ? transport(base) : base;
  }, [scenario, hash, transport, theme]);
  return (
    <View style={{ flex: 1 }}>
      <ProjectScreen device={{ id: "visual-qa", name: "StudioE2E on DEV-PC", online: true, computerKey: "k", lastSeen: ago(0) }} transport={t} onBack={none} onUnpaired={none} />
      {children}
    </View>
  );
}

/** steps-folded's session holding a reply about 6000 dp tall: the newest line, or an older one with a short turn after it. */
function longThread(newest: boolean): Scenario {
  const base = SCENARIOS["steps-folded"];
  const at = ago(5);
  const transcript: TranscriptEntry[] = [
    { kind: "user", text: "How much of the built code carries over to the bastion plan?", at },
    { kind: "assistant", text: longReply(), at },
    ...(newest ? [] : ([
      { kind: "user", text: "Start with the save system.", at },
      { kind: "assistant", text: "Starting there: region, beacon and camp state go into ValeSaveSystem first.", at },
    ] as TranscriptEntry[])),
  ];
  return { ...base, session: { ...base.session!, title: LONG_TITLE, status: "idle", transcript } };
}
const LONG_TITLE = "Core game loop revisions";
const LONG_OLDER = longThread(false);
const LONG_NEWEST = longThread(true);

/** An older long reply between a table, the user's own message and a finished shell step folded to one row: the rows around a Show more. */
function betweenThread(): Scenario {
  const base = SCENARIOS["steps-folded"];
  const at = ago(5);
  const table = ["Agreed, structurally it is Hades. The match:", "", "| Hades | The loop we sketched |", "| --- | --- |", "| The House | the bastion |", "| Hades at the end | the Omen at the end |", "| Back home win or lose | the same |"].join("\n");
  const transcript: TranscriptEntry[] = [
    { kind: "user", text: "Does the loop match anything?", at },
    { kind: "assistant", text: table, at },
    { kind: "user", text: "Honestly I am now realizing that the game loop really mirrors Hades more than anything else.", at },
    { kind: "assistant", text: longReply(), at },
    { kind: "tool", call: { id: "sh-1", name: "shell", input: { command: "set -e; f=.wiki/Core-Loop.md" }, outcome: "done", startedAt: at, endedAt: at, result: "done" } },
    { kind: "assistant", text: "Logging it as a reference point under Decision 14. It is useful framing, not a decision.", at },
  ];
  return { ...base, session: { ...base.session!, title: LONG_TITLE, status: "idle", transcript } };
}
const LONG_BETWEEN = betweenThread();

/** A soft keyboard's height on a 390 by 844 phone, and a draft far longer than the room above it. */
const KEYBOARD = 300;
const LONG_DRAFT = [
  "Also, yes the persisting stuff would ostensibly be things like home base upgrades, equipment, facilities, new biomes and quest types unlocking, etc.",
  "In fact, I think some of the docs already mentioned the concept of the omen and maybe that is the final destination of each run. Restore POIs on the way to the omen, kill the big baddie, reset.",
  "But ultimately the player returns to the home base and readies for the next bout, spending what the run brought back on the next set of upgrades.",
  "The question is how much of the map persists between runs: the restored POIs could stay restored, or the omen could undo a share of them each time.",
].join("\n\n");
const LONG_DRAFT_SCENARIO: Scenario = { ...LONG_OLDER, session: { ...LONG_OLDER.session!, draft: LONG_DRAFT } };

/** The keys, drawn where the native KeyboardAvoidingView would leave them: under the chat, which gives up their height. */
function OnKeyboard({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
      <View style={{ height: KEYBOARD, backgroundColor: "#1b2421", borderTopWidth: 1, borderTopColor: t.c.line }} />
    </View>
  );
}

const oldStudio = (base: Transport): Transport => (method, path, o) => (path.startsWith("/v1/health") ? healthOf("0.1.25-beta.12")(method, path, o) : base(method, path, o));

export interface Scene {
  title: string;
  /** Run once before the first draw: the relay's answers and the native mocks' state. */
  setup?: () => void;
  /** Pressed in order before the shot, by accessibility label or text. */
  clicks?: string[];
  /** Typed into a field after the clicks, by its accessibility label. */
  type?: { into: string; text: string };
  draw: () => ReactNode;
}

export const SCENES: Record<string, Scene> = {
  "pair-welcome": { title: "Not paired: scan the code, or paste its link", draw: () => <Welcome onScan={none} onLink={none} /> },
  "pair-welcome-error": { title: "The relay forgot this phone: the welcome says why", draw: () => <Welcome error="The relay no longer knows this phone. Pair it again." onScan={none} onLink={none} /> },
  "pair-paste": { title: "Paste pairing link pressed with a pairing link on the clipboard", setup: () => void (clip.text = "https://remote.ue-mcp.com/pair#c0de42.QmFzZTY0UHVibGljS2V5.c2VjcmV0"), clicks: ["Paste pairing link"], draw: () => <Welcome onScan={none} onLink={none} /> },
  "pair-paste-empty": { title: "Paste pairing link pressed with nothing on the clipboard", setup: () => void (clip.text = ""), clicks: ["Paste pairing link"], draw: () => <Welcome onScan={none} onLink={none} /> },
  "pair-paste-wrong": { title: "A pasted link that is not a pairing link, Pair pressed", setup: () => void (clip.text = ""), clicks: ["Paste pairing link"], type: { into: "Pairing link", text: "https://example.com/meeting" }, draw: () => <Welcome onScan={none} onLink={none} /> },
  "pair-connecting": { title: "Pairing under way: contacting the relay", draw: () => <Pairing step={{ kind: "status", text: "Contacting the relay" }} /> },
  "pair-proving": { title: "Pairing under way: proving this phone to the computer", draw: () => <Pairing step={{ kind: "status", text: "Connecting to your computer" }} /> },
  "pair-approval": { title: "Waiting for the owner to allow this phone: the code to compare", draw: () => <Pairing step={{ kind: "code", code: "482913" }} /> },
  "pair-paired": { title: "Paired, before the projects open", draw: () => <Paired /> },
  "pair-expired": { title: "The code was used or ran out", draw: () => failed("expired", "That code is used or expired. Make a new one on your computer.") },
  "pair-timeout": { title: "Nobody allowed this phone within 2 minutes", draw: () => failed("timeout", "Nobody allowed this device on the computer within 2 minutes. Make a new code.") },
  "pair-denied": { title: "The owner chose Deny", draw: () => failed("denied", "The computer denied this device.") },
  "pair-offline": { title: "The computer went offline while pairing", draw: () => failed("offline", "That project went offline. Make a new code once it is back.") },
  "pair-network": { title: "The relay could not be reached: Try again", draw: () => failed("network", "Network request failed") },
  "pair-plan": { title: "The account has no remote control in its plan", draw: () => failed("plan", "Remote control needs the Remote or Pro plan on this account.") },
  "pair-bad-link": { title: "A scanned or pasted code that is not a pairing code", draw: () => failed("bad-link", "That is not a whole UE-MCP Studio pairing code.") },
  "pair-mismatch": { title: "The computer's answer did not match the code", draw: () => failed("mismatch", "The answer did not match the pairing code, so this phone does not trust it.") },
  "pair-failed": { title: "Anything else the relay or the computer refused with", draw: () => failed("failed", "The computer no longer knows this request. Make a new code.") },

  "scanner": { title: "The scanner over the camera", setup: () => void (g.__qaCameraFeed = true), draw: () => <Scanner onCode={none} onCancel={none} /> },
  "scanner-torch": { title: "The scanner with the torch on", setup: () => void (g.__qaCameraFeed = true), clicks: ["Torch"], draw: () => <Scanner onCode={none} onCancel={none} /> },
  "scanner-no-code": { title: "Scan from a picture with no code in the picture", setup: () => ((g.__qaCameraFeed = true), (picked.next = { canceled: false, assets: [{ uri: "qa://picture.png" }] })), clicks: ["Scan from a picture"], draw: () => <Scanner onCode={none} onCancel={none} /> },
  "scanner-asking": { title: "The camera permission not known yet", setup: () => void (g.__qaCamera = null), draw: () => <Scanner onCode={none} onCancel={none} /> },
  "scanner-permission": { title: "The camera not allowed yet: Allow camera", setup: () => void (g.__qaCamera = { granted: false, canAskAgain: true, status: "undetermined" }), draw: () => <Scanner onCode={none} onCancel={none} /> },
  "scanner-permission-denied": { title: "The camera refused for good: Open settings", setup: () => void (g.__qaCamera = { granted: false, canAskAgain: false, status: "denied" }), draw: () => <Scanner onCode={none} onCancel={none} /> },
  "scanner-permission-no-code": {
    title: "The camera refused, a picture without a code picked",
    setup: () => ((g.__qaCamera = { granted: false, canAskAgain: false, status: "denied" }), (picked.next = { canceled: false, assets: [{ uri: "qa://picture.png" }] })),
    clicks: ["Scan from a picture"],
    draw: () => <Scanner onCode={none} onCancel={none} />,
  },

  "projects": { title: "Projects: paired, opened last, on another computer, offline", setup: () => (relay({}), pairedWith(["keyA"], DEVICES[0])), draw: () => <Projects onOpen={none} onPair={none} onSettings={none} onUnpaired={none} /> },
  "projects-loading": { title: "Projects while the relay has not answered", setup: () => (relay({ hang: true }), pairedWith(["keyA"])), draw: () => <Projects onOpen={none} onPair={none} onSettings={none} onUnpaired={none} /> },
  "projects-empty": { title: "Projects with none connected yet", setup: () => (relay({ devices: [] }), pairedWith(["keyA"])), draw: () => <Projects onOpen={none} onPair={none} onSettings={none} onUnpaired={none} /> },
  "projects-error": { title: "Projects when the relay answers with an error", setup: () => (relay({ status: 503 }), pairedWith(["keyA"])), draw: () => <Projects onOpen={none} onPair={none} onSettings={none} onUnpaired={none} /> },
  "devices": { title: "Paired devices: this phone, other browsers, the computer it trusts", setup: () => (relay({}), pairedWith(["keyA"])), draw: () => <Settings onBack={none} onRemoved={none} onAbout={none} /> },
  "devices-loading": { title: "Paired devices while the relay has not answered", setup: () => (relay({ hang: true }), pairedWith(["keyA"])), draw: () => <Settings onBack={none} onRemoved={none} onAbout={none} /> },
  "devices-error": { title: "Paired devices when the relay answers with an error", setup: () => (relay({ status: 503 }), pairedWith(["keyA"])), draw: () => <Settings onBack={none} onRemoved={none} onAbout={none} /> },
  "about": { title: "About: this app, and the Studio on the last project's computer", setup: () => pairedWith(["keyA"], DEVICES[0]), draw: () => <About onBack={none} transport={() => healthOf("0.1.25-beta.40")} /> },
  "about-too-old": { title: "About when that Studio is older than this app needs", setup: () => pairedWith(["keyA"], DEVICES[0]), draw: () => <About onBack={none} transport={() => healthOf("0.1.25-beta.12")} /> },
  "about-unreachable": { title: "About when the computer does not answer", setup: () => pairedWith(["keyA"], DEVICES[0]), draw: () => <About onBack={none} transport={() => unreachable} /> },
  "about-no-project": { title: "About before any project was opened", draw: () => <About onBack={none} /> },

  "offline-projects": { title: "This phone offline, over the projects", setup: () => (relay({}), pairedWith(["keyA"], DEVICES[0]), (g.__qaOffline = true)), draw: () => (<><Projects onOpen={none} onPair={none} onSettings={none} onUnpaired={none} /><OfflineBanner /></>) },
  "offline-project": { title: "This phone offline, over an open project", setup: () => void (g.__qaOffline = true), draw: () => (<><InProject name="session-empty" /><OfflineBanner /></>) },
  "compat-banner": { title: "The computer's Studio is older than this app needs: the banner under the bar", draw: () => <InProject name="session-empty" hash="#/chat" transport={oldStudio} /> },
  "share-pick-session": {
    title: "Something shared into Studio: pick the session it goes to",
    setup: () => void (g.__qaShared = { files: [{ uri: "file:///shot.png", name: "shot.png", mimeType: "image/png" }], text: null, consume: none }),
    draw: () => <InProject name="session-empty" hash="#/chat" />,
  },
  "lock-fingerprint": {
    title: "The lock screen with fingerprint unlock on",
    setup: () => void (g.__qaBiometric = { available: true, enabled: true, unlock: async () => null, remember: async () => undefined, forget: async () => undefined }),
    draw: () => <InProject name="remote-lock-screen" />,
  },
  "thread-show-more-folded": { title: "A long reply above a newer turn: folded at 400 dp, faded into the panel, Show more centred under it", clicks: [LONG_TITLE], draw: () => <InProject name="steps-folded" scenario={LONG_OLDER} /> },
  "thread-show-more-expanded": { title: "That reply opened: its last piece, Show less centred under it", clicks: [LONG_TITLE, "Show more"], draw: () => <InProject name="steps-folded" scenario={LONG_OLDER} /> },
  "thread-show-more-between": { title: "An older long reply opened between a table, the user's message and a folded shell step: each row below the last", clicks: [LONG_TITLE, "Show more"], draw: () => <InProject name="steps-folded" scenario={LONG_BETWEEN} /> },
  "thread-newest-long": { title: "A reply about 6000 dp tall as the newest line: never folded, drawn as pieces", clicks: [LONG_TITLE], draw: () => <InProject name="steps-folded" scenario={LONG_NEWEST} /> },
  "composer-long-draft-keyboard": {
    title: "A long draft with the keyboard up: the box stops at the room above the keys and scrolls, the bar stays on the keys",
    setup: () => setKeyboardHeight(KEYBOARD),
    clicks: [LONG_TITLE],
    draw: () => <OnKeyboard><InProject name="steps-folded" scenario={LONG_DRAFT_SCENARIO} /></OnKeyboard>,
  },
  "lock-remember": { title: "After a typed PIN: the fingerprint offered for next time", draw: () => <InProject name="session-empty"><RememberOffer onYes={none} onNo={none} /></InProject> },
};

/** The relay page each pairing scene answers to: its shot's name, beside which the parity script puts the app's. */
export const REFERENCE: Record<string, string> = {
  "pair-welcome": "relay-unpaired",
  "pair-welcome-error": "relay-unpaired",
  "pair-paste": "relay-unpaired",
  "pair-paste-empty": "relay-unpaired",
  "pair-paste-wrong": "relay-unpaired",
  "pair-connecting": "relay-pair-connecting",
  "pair-proving": "relay-pair-connecting",
  "pair-approval": "relay-pair-approval",
  "pair-paired": "relay-pair-done",
  "pair-expired": "relay-pair-expired",
  "pair-timeout": "relay-pair-expired",
  "pair-denied": "relay-pair-denied",
  "pair-offline": "relay-pair-offline",
  "pair-network": "relay-pair-offline",
  "pair-plan": "relay-sw-plan",
  "pair-bad-link": "relay-pair-bad-link",
  "pair-mismatch": "relay-pair-denied",
  "pair-failed": "relay-pair-denied",
  projects: "relay-home-list",
  "projects-loading": "relay-home-opening",
  "projects-error": "relay-home-relay-error",
};

export function SceneHarness({ name, theme }: { name: string; theme: StudioTheme }) {
  const scene = SCENES[name];
  // The scene's mocks are in place before anything of it draws.
  useState(() => scene?.setup?.());
  const fonts = useStudioFonts();
  return (
    <ThemeProvider name={theme}>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>
        <View style={{ flex: 1 }}>{fonts && scene ? scene.draw() : null}</View>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
