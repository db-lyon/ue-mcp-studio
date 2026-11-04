/**
 * Every screen of the app in the states worth looking at, rendered with
 * react-native-web against fixture answers, for scripts/visual-qa-mobile.mjs to
 * screenshot at phone sizes. No relay, computer or daemon is involved.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { createLock, type StudioApi, type Transport } from "@ue-mcp-studio/client-core";
import type { DialogsState, EditorDialog, ModelCatalog, SessionDetail, StudioSettings, TranscriptEntry, TurnReview } from "@ue-mcp-studio/shared";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Project } from "../src/connection";
import { ProjectContext, type ProjectNav } from "../src/nav";
import { Pairing, Welcome } from "../src/screens/Pairing";
import { Projects } from "../src/screens/Projects";
import { Settings } from "../src/screens/Settings";
import { SessionScreen } from "../src/screens/Session";
import { ReviewItemScreen, ReviewScreen } from "../src/screens/Review";
import { CheckpointsScreen } from "../src/screens/Checkpoints";
import { ChangeScreen, ChangesScreen } from "../src/screens/Changes";
import { PinPad } from "../src/PinPad";
import { s } from "../src/legacy-ui";

const at = "2026-11-04T12:00:00Z";
const never = () => new Promise<never>(() => undefined);

const settings = { provider: "anthropic", model: "claude-opus", effort: "high", connected: { claude: true } } as unknown as StudioSettings;
const catalog: ModelCatalog = {
  signedIn: { claude: true, chatgpt: false, studio: false } as ModelCatalog["signedIn"],
  providers: [
    { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-opus", name: "Claude Opus", signIns: ["claude"] }, { id: "claude-sonnet", name: "Claude Sonnet", signIns: ["claude"] }] },
    { id: "openai", name: "OpenAI", connected: false, source: "default", models: [{ id: "gpt", name: "GPT", signIns: ["chatgpt"] }] },
  ] as ModelCatalog["providers"],
};

const review: TurnReview = {
  id: "r1",
  turn: 0,
  before: "c0",
  after: "c1",
  at,
  items: [
    { path: "Content/Blueprints/BP_Door.uasset", status: "modified", kind: "package", group: "blueprint", state: "pending", summary: "Open Speed: 1 to 2.5; Auto Close added" },
    { path: "Content/UI/WBP_Hud.uasset", status: "modified", kind: "package", group: "blueprint", state: "kept", summary: "HealthBar > Hide when Full: False to True" },
    { path: "Content/Maps/Lobby.umap", status: "modified", kind: "package", group: "level", state: "reverted", undo: "c0", summary: "2 actors added" },
    { path: "Config/DefaultGame.ini", status: "modified", kind: "config", group: "config", state: "pending", conflict: true, summary: "1 line changed" },
    { path: "Source/Lyra/Door.cpp", status: "added", kind: "source", group: "source", state: "pending", summary: "42 lines" },
  ],
};

const transcript: TranscriptEntry[] = [
  { kind: "user", text: "Make the lobby door open when a player walks up, and close after 3 seconds.", at },
  { kind: "tool", call: { id: "c1", name: "ue_mcp", input: { action: "call", category: "blueprint", method: "add_component" }, outcome: "done", startedAt: at, endedAt: at } },
  { kind: "tool", call: { id: "c2", name: "read_file", input: { path: "Source/Lyra/Door.h" }, outcome: "done", startedAt: at, endedAt: at } },
  { kind: "tool", call: { id: "c3", name: "shell", input: { command: "git diff --stat" }, outcome: "error", startedAt: at, endedAt: at } },
  {
    kind: "assistant",
    text: "Done. **BP_Door** now opens on overlap:\n\n1. Added a `BoxCollision` trigger\n2. Timeline `OpenDoor` drives the rotation\n3. Closes after `AutoCloseDelay` (3s)\n\n```cpp\nvoid ADoor::OnOverlap(AActor* Other)\n{\n    if (Other->IsA<APawn>()) Open();\n}\n```\n\nSee [the docs](https://ue-mcp.com) for the trigger setup.",
    at,
  },
  { kind: "review", review },
  { kind: "user", text: "Also add a sound when it opens.", at },
];

const approvals: SessionDetail["approvals"] = [
  { id: "a1", toolUseId: "t1", tool: "shell", parent: null, command: "git checkout -- Content/Maps/Lobby.umap", cwd: "D:/Projects/Lyra", at },
  {
    id: "a2",
    toolUseId: "t2",
    tool: "edit_file",
    parent: null,
    path: "D:/Projects/Lyra/Source/Lyra/Door.cpp",
    diff: [{ op: " ", text: "void ADoor::Open()" }, { op: " ", text: "{" }, { op: "-", text: "    Timeline->Play();" }, { op: "+", text: "    Timeline->Play();" }, { op: "+", text: "    UGameplayStatics::PlaySoundAtLocation(this, OpenSound, GetActorLocation());" }, { op: " ", text: "}" }],
    at,
  },
];

const dialog: EditorDialog = {
  id: "d1",
  editor: "Unreal Editor",
  title: "Save Content",
  message: "Save changes to the following assets?",
  buttons: ["Save Selected", "Don't Save", "Cancel"],
  items: [
    { index: 0, label: "BP_Door", cells: ["BP_Door", "/Game/Blueprints/BP_Door"], checked: true },
    { index: 1, label: "Lobby", cells: ["Lobby", "/Game/Maps/Lobby"], checked: false },
  ],
  mode: "interactive",
  openedAt: Date.now() - 4000,
  sessionId: "s1",
  toolUseId: null,
  parent: null,
  call: "editor.stop_editor",
  asking: { since: Date.now() - 4000, minHumanMs: 0, policy: { kind: "agent" } as never, deadline: Date.now() + 52_000, safeButton: null },
  held: null,
  steps: [],
  outcome: null,
};

function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "s1",
    title: "Lobby door opens on approach",
    status: "idle",
    createdAt: at,
    updatedAt: at,
    waitingCause: null,
    archived: false,
    agents: { total: 0, running: 0 },
    awaiting: 0,
    transcript,
    touched: [],
    draft: "",
    seen: [],
    dismissed: [],
    queue: [],
    error: null,
    approvals: [],
    timeline: [
      { checkpoint: "c1", label: "Make the lobby door open", at, kind: "turn", turn: 0 },
      { checkpoint: "c2", label: "Also add a sound", at: "2026-11-04T12:10:00Z", kind: "turn", turn: 6 },
      { checkpoint: "c3", label: "Restored to Make the lobby door open", at: "2026-11-04T12:20:00Z", kind: "restore", undo: "c2" },
    ],
    review: null,
    ...over,
  } as SessionDetail;
}

function api(over: Partial<Record<keyof StudioApi, unknown>> = {}): StudioApi {
  const answers: Partial<Record<keyof StudioApi, unknown>> = {
    health: { version: "1.4.13" },
    sessions: {
      sessions: [
        { id: "s1", title: "Lobby door opens on approach", status: "running", updatedAt: "2026-11-04T12:30:00Z", archived: false, awaiting: 1 },
        { id: "s2", title: "Fix the HUD health bar", status: "idle", updatedAt: "2026-11-04T10:00:00Z", archived: false, awaiting: 0 },
        { id: "s3", title: "Playtest: jump over the gap", status: "error", updatedAt: "2026-11-03T18:00:00Z", archived: false, awaiting: 0 },
      ],
    },
    sessionSync: detail(),
    settings,
    models: catalog,
    dialogs: { now: Date.now(), dialogs: [] } satisfies DialogsState,
    reviewStatus: { default: true },
    vcs: { vcs: { kind: "git", name: "Git", branch: "feature/door", changes: 6, ahead: 2, behind: 0, root: "D:/Projects/Lyra" } },
    vcsChanges: {
      changes: [
        { path: "Content/Blueprints/BP_Door.uasset", status: "modified" },
        { path: "Content/Blueprints/BP_DoorFrame.uasset", status: "added" },
        { path: "Content/Maps/Lobby.umap", status: "modified" },
        { path: "Config/DefaultGame.ini", status: "modified" },
        { path: "Source/Lyra/Door.cpp", status: "added" },
        { path: "Source/Lyra/OldDoor.cpp", status: "deleted" },
      ],
      truncated: false,
    },
    vcsDiff: { diff: "diff --git a/Config/DefaultGame.ini b/Config/DefaultGame.ini\n@@ -12,4 +12,5 @@\n [/Script/Lyra.Door]\n-OpenSpeed=1.0\n+OpenSpeed=2.5\n+AutoCloseDelay=3.0\n bReplicates=True\n" },
    reviewDiff: {
      change: {
        path: "Content/UI/WBP_Hud.uasset",
        status: "modified",
        kind: "package",
        assetDiff: {
          state: "ready",
          status: "modified",
          assetClass: "WidgetBlueprint",
          summary: "Widget Blueprint changed. HealthBar > Hide when Full: False to True; Percent: 0.5 to 1",
          nativeDiff: { available: true },
          before: { class: "WidgetBlueprint", facts: [{ name: "Widgets", value: "12" }] },
          after: { class: "WidgetBlueprint", facts: [{ name: "Widgets", value: "13" }] },
          sections: [
            {
              category: "Widget Tree",
              kind: "properties",
              engineSource: "UBlueprint::FindDiffs",
              entries: [
                { displayString: "bHideWhenFull", diffType: "PropertyValueChanged", group: "HealthBar", path: "bHideWhenFull", label: "Hide when Full", before: "False", after: "True" },
                { displayString: "Percent", diffType: "PropertyValueChanged", group: "HealthBar", path: "Percent", before: "0.500000", after: "1.000000" },
                { displayString: "ColorAndOpacity", diffType: "PropertyValueChanged", group: "Title", path: "ColorAndOpacity", label: "Color and Opacity", before: "(R=1.000000,G=1.000000,B=1.000000,A=1.000000)", after: "(R=0.909804,G=0.447059,B=0.047059,A=1.000000)" },
              ],
              hiddenChanges: 2,
            },
          ],
        },
      },
    },
    ...over,
  };
  return new Proxy({} as StudioApi, {
    get: (_t, k: string) => () => (k in answers ? Promise.resolve(answers[k as keyof StudioApi]) : never()),
  });
}

const okTransport: Transport = async () => ({ status: 200, headers: {}, body: null });

function project(): Project {
  return {
    device: { id: "dev1", name: "Lyra", online: true, computerKey: "keyA", lastSeen: at },
    transport: okTransport,
    lock: createLock(okTransport),
    live: "live",
    dropCause: null,
    onEvent: () => () => undefined,
  };
}

function InProject({ children, studio = api() }: { children: ReactNode; studio?: StudioApi }) {
  const nav: ProjectNav = { project: project(), api: studio, push: () => undefined, pop: () => undefined };
  return <ProjectContext.Provider value={nav}>{children}</ProjectContext.Provider>;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider style={s.root}>
      <View style={{ flex: 1 }}>{children}</View>
    </SafeAreaProvider>
  );
}

const lockState = { whole: true, sensitive: true, locked: true, sensitiveOpen: false, idleMinutes: 10, pinLength: 6 };

/** Scenes by name; `click` is text a scene clicks after it renders (to open a sheet). */
export const SCENES: Record<string, { render: () => ReactNode; click?: string }> = {
  welcome: { render: () => <Welcome onScan={() => undefined} onLink={() => undefined} /> },
  "welcome-error": { render: () => <Welcome error="That code is used or expired. Make a new one on your computer." onScan={() => undefined} onLink={() => undefined} /> },
  "pairing-code": { render: () => <Pairing step={{ kind: "code", code: "482913" }} /> },
  "pairing-status": { render: () => <Pairing step={{ kind: "status", text: "Pairing with your computer" }} /> },
  projects: { render: () => <Projects onOpen={() => undefined} onPair={() => undefined} onSettings={() => undefined} onUnpaired={() => undefined} /> },
  devices: { render: () => <Settings onBack={() => undefined} onRemoved={() => undefined} /> },
  session: { render: () => <InProject><SessionScreen id="s1" /></InProject> },
  "session-running": {
    render: () => (
      <InProject studio={api({ sessionSync: detail({ status: "running", queue: [{ id: "q1", text: "Then make the frame glow while it is open.", attachments: [], at }, { id: "q2", text: "And log each open to the console.", attachments: [], at }] }) })}>
        <SessionScreen id="s1" />
      </InProject>
    ),
  },
  "session-approvals": { render: () => <InProject studio={api({ sessionSync: detail({ status: "waiting", approvals }) })}><SessionScreen id="s1" /></InProject> },
  "session-dialog": { render: () => <InProject studio={api({ sessionSync: detail({ status: "waiting" }), dialogs: { now: Date.now(), dialogs: [dialog] } })}><SessionScreen id="s1" /></InProject> },
  "session-empty": { render: () => <InProject studio={api({ sessionSync: detail({ transcript: [], title: "" }) })}><SessionScreen id="s1" /></InProject> },
  "model-picker": { render: () => <InProject><SessionScreen id="s1" /></InProject>, click: "Claude Opus" },
  review: { render: () => <InProject><ReviewScreen sessionId="s1" review={review} /></InProject> },
  "review-item-asset": { render: () => <InProject><ReviewItemScreen sessionId="s1" reviewId="r1" path="Content/UI/WBP_Hud.uasset" /></InProject> },
  "review-item-text": {
    render: () => (
      <InProject studio={api({ reviewDiff: { change: { path: "Config/DefaultGame.ini", status: "modified", kind: "config", diff: "@@ -12,3 +12,4 @@\n [/Script/Lyra.Door]\n-OpenSpeed=1.0\n+OpenSpeed=2.5\n+AutoCloseDelay=3.0\n bReplicates=True\n" } } })}>
        <ReviewItemScreen sessionId="s1" reviewId="r1" path="Config/DefaultGame.ini" />
      </InProject>
    ),
  },
  checkpoints: { render: () => <InProject><CheckpointsScreen sessionId="s1" /></InProject> },
  changes: { render: () => <InProject><ChangesScreen /></InProject> },
  "changes-tree": { render: () => <InProject><ChangesScreen /></InProject>, click: "Tree" },
  change: { render: () => <InProject><ChangeScreen path="Config/DefaultGame.ini" /></InProject> },
  "lock-screen": { render: () => <PinPad lock={createLock(okTransport)} view={{ state: lockState, screen: true, prompt: false, removed: false }} onRemoved={() => undefined} /> },
  "lock-sheet": { render: () => <PinPad lock={createLock(okTransport)} view={{ state: { ...lockState, locked: false, pinLength: undefined }, screen: false, prompt: true, removed: false }} onRemoved={() => undefined} /> },
};

export function Scene({ name }: { name: string }) {
  const scene = SCENES[name];
  return <Frame>{scene ? scene.render() : null}</Frame>;
}
