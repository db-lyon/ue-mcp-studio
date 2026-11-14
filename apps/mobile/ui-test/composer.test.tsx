// The composer port: the message box and its bar, the slash and @-mention
// menus, the pill row, the /flow and /action launchers and the model picker.
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ActionListing, FlowListing, MentionMatch, MentionSearchResponse, ModelCatalog, StudioSettings } from "@ue-mcp-studio/shared";
import { mentionToken } from "@ue-mcp-studio/shared";
import { Platform, View } from "react-native";
import { AgentsGlyph, Composer, CheckpointsGlyph } from "../src/chat/Composer";
import { BarTierContext } from "../src/chat/barTier";
import { MentionText, type MentionSearchFn } from "../src/chat/MentionMenu";
import { PillRow } from "../src/chat/Pills";
import { FlowLauncher } from "../src/chat/FlowCommand";
import { ActionLauncher } from "../src/chat/ActionCommand";
import { useAttachments, type PendingFile, type PickedFile } from "../src/chat/attachments";
import { EffortPicker, ModelAndEffort, ModelPicker } from "../src/views/ModelPicker";
import { picked as imagePicked } from "./mocks/image-picker";
import { picked as docPicked } from "./mocks/document-picker";
import { clip } from "./mocks/clipboard";
import { fakeApi, renderInProject, settle } from "./helpers";

type Props = Partial<Parameters<typeof Composer>[0]>;

/** The composer with its draft kept, as views/Chat.tsx keeps it. */
function Box(props: Props & { initial?: string }) {
  const [draft, setDraft] = useState(props.initial ?? "");
  return (
    <Composer
      draft={draft}
      onDraft={setDraft}
      onBlur={() => undefined}
      placeholder="Ask for something"
      busy={false}
      canSend={!!draft.trim()}
      onSend={() => undefined}
      onStop={() => undefined}
      files={[]}
      onAddFiles={() => undefined}
      onRemoveFile={() => undefined}
      picker={null}
      {...props}
    />
  );
}

const box = () => document.querySelector("textarea:not([aria-hidden])") as HTMLTextAreaElement;

/** Types into the box with the caret at the end, as a person does. */
function type(text: string) {
  const el = box();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.select(el);
}

const button = (name: string) => screen.getByRole("button", { name });

/** A menu row picked with a tap; the press keeps the focus in the box (keepFocus). */
function pressRow(el: HTMLElement) {
  const kept = fireEvent.mouseDown(el, { button: 0, buttons: 1 });
  expect(kept).toBe(false);
  fireEvent.mouseUp(el, { button: 0 });
  fireEvent.click(el);
}

/** Opens a picker's menu: it is placed from the button's measure, which answers a frame later. */
async function openPicker(name: string) {
  fireEvent.click(button(name));
  await settle();
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
}

describe("Composer", () => {
  it("sends with Send, which waits for text", () => {
    const onSend = vi.fn();
    render(<Box onSend={onSend} />);
    expect(screen.getByPlaceholderText("Ask for something")).toBeTruthy();
    expect(button("Send").getAttribute("aria-disabled")).toBe("true");
    type("Add a second door trigger by the ledge");
    fireEvent.click(button("Send"));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("while a turn runs: Queue and Stop, and the box stays open for the next message", () => {
    const onQueue = vi.fn();
    const onStop = vi.fn();
    render(<Box busy initial="Then check the sprint speed" onQueue={onQueue} onStop={onStop} placeholder="Queue a message" />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(button("Queue"));
    fireEvent.click(button("Stop"));
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(box().readOnly).toBe(false);
  });

  it("is closed while a turn runs when nothing can queue", () => {
    render(<Box busy />);
    expect(box().readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
  });

  it("shows attached files as chips, each with its state and a remove button", () => {
    const files: PendingFile[] = [
      { key: "a", name: "shot.png", type: "image/png", size: 3000, preview: null, state: "ready" },
      { key: "b", name: "notes", type: "text/plain", size: 10, preview: null, state: "uploading" },
      { key: "c", name: "big.zip", type: "application/zip", size: 1, preview: null, state: "error", error: "larger than 100.0 MB" },
    ];
    const onRemoveFile = vi.fn();
    render(<Box files={files} onRemoveFile={onRemoveFile} />);
    const list = screen.getByLabelText("Attached files");
    expect(within(list).getByText("PNG")).toBeTruthy();
    expect(within(list).getByText("3 KB")).toBeTruthy();
    expect(within(list).getByText("FILE")).toBeTruthy();
    expect(within(list).getByText("adding")).toBeTruthy();
    expect(within(list).getByText("larger than 100.0 MB")).toBeTruthy();
    fireEvent.click(button("Remove shot.png"));
    expect(onRemoveFile).toHaveBeenCalledWith("a");
  });

  it("attaches photos or files picked from the phone", async () => {
    const onAddFiles = vi.fn();
    render(<Box onAddFiles={onAddFiles} />);
    imagePicked.next = { canceled: false, assets: [{ uri: "file:///p.jpg", fileName: "p.jpg", mimeType: "image/jpeg", fileSize: 2048, base64: "AAAA", width: 1, height: 1 }] };
    fireEvent.click(button("Attach"));
    fireEvent.click(button("Attach photos"));
    await settle();
    expect(onAddFiles).toHaveBeenLastCalledWith([{ uri: "file:///p.jpg", name: "p.jpg", type: "image/jpeg", size: 2048, base64: "AAAA" }]);
    docPicked.next = { canceled: false, assets: [{ uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain", size: 5 }] };
    fireEvent.click(button("Attach"));
    fireEvent.click(button("Attach files"));
    await settle();
    expect(onAddFiles).toHaveBeenLastCalledWith([{ uri: "file:///a.txt", name: "a.txt", type: "text/plain", size: 5, base64: undefined }]);
  });

  it("takes a photo with the camera, and says so in the sheet when the camera is refused", async () => {
    const onAddFiles = vi.fn();
    render(<Box onAddFiles={onAddFiles} />);
    imagePicked.camera = { canceled: false, assets: [{ uri: "file:///c.jpg", fileName: null, mimeType: "image/jpeg", fileSize: 4096, base64: "BBBB", width: 1, height: 1 }] };
    fireEvent.click(button("Attach"));
    fireEvent.click(button("Take a photo"));
    await settle();
    expect(onAddFiles).toHaveBeenLastCalledWith([{ uri: "file:///c.jpg", name: "camera-1.jpeg", type: "image/jpeg", size: 4096, base64: "BBBB" }]);
    imagePicked.granted = false;
    try {
      fireEvent.click(button("Attach"));
      fireEvent.click(button("Take a photo"));
      await settle();
      expect(screen.getByRole("alert").textContent).toBe("Studio may not use the camera. Allow it in the phone's settings.");
      expect(onAddFiles).toHaveBeenCalledTimes(1);
    } finally {
      imagePicked.granted = true;
    }
  });

  it("offers Paste image only while the clipboard holds one, and attaches it as a png", async () => {
    const onAddFiles = vi.fn();
    render(<Box onAddFiles={onAddFiles} />);
    fireEvent.click(button("Attach"));
    await settle();
    expect(screen.queryByRole("button", { name: "Paste the copied image" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    clip.image = { data: "data:image/png;base64,iVBORw0KGgo=", size: { width: 1, height: 1 } };
    try {
      fireEvent.click(button("Attach"));
      await settle();
      fireEvent.click(button("Paste the copied image"));
      await settle();
      const [[files]] = onAddFiles.mock.calls as [[PickedFile[]]];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ type: "image/png", base64: "iVBORw0KGgo=", size: 9 });
      expect(files[0].name).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
    } finally {
      clip.image = null;
    }
  });

  it("shows no words for the keys: a phone has no shortcuts to hint at, a tablet hears them in Send's hint", () => {
    render(<Box onQueue={() => undefined} />);
    expect(screen.queryByText(/Enter to send/)).toBeNull();
  });

  it("the resize handle: steps with the screen reader's adjust actions, and a double tap forgets the height", () => {
    const onHeight = vi.fn();
    render(<Box height={120} onHeight={onHeight} />);
    const handle = screen.getByLabelText("Resize the message box");
    expect(handle).toBeTruthy();
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(handle, { key: "ArrowUp" });
      act(() => void vi.advanceTimersByTime(500));
      expect(onHeight).toHaveBeenLastCalledWith(136);
      fireEvent.keyDown(handle, { key: "Home" });
      expect(onHeight).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** What the platform reports when it lays an element out `width` dp wide. */
function layOut(el: Element, width: number) {
  const handler = (el as unknown as { __reactLayoutHandler?: (e: unknown) => void }).__reactLayoutHandler;
  if (!handler) throw new Error("no layout handler on the element");
  act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width, height: 44 } } }));
}

// The same React Native code draws the bar on Android and iOS: nothing here branches on the platform.
describe.each(["android", "ios"] as const)("the bar's utilities, on %s", (os) => {
  const withOs = async (f: () => void | Promise<void>) => {
    const was = Platform.OS;
    Object.defineProperty(Platform, "OS", { value: os, configurable: true });
    try {
      await f();
    } finally {
      Object.defineProperty(Platform, "OS", { value: was, configurable: true });
    }
  };
  const utilities = (review: () => void, agents: () => void) => [
    { id: "subagents" as const, icon: <AgentsGlyph />, count: 2, onClick: agents },
    { id: "checkpoints" as const, icon: <CheckpointsGlyph />, onClick: review },
  ];

  it("are icons after the model, in order, named for a screen reader, with Subagents' count as a badge", () => withOs(() => {
    const review = vi.fn();
    const agents = vi.fn();
    render(<Box utilities={utilities(review, agents)} />);
    const slot = screen.getByTestId("composer-utilities");
    const names = within(slot).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Checkpoints", "Subagents (2)", "Attach"]);
    // No words on the bar: only the badge's count.
    expect(slot.textContent).toBe("2");
    fireEvent.click(button("Checkpoints"));
    fireEvent.click(button("Subagents (2)"));
    expect([review, agents].every((f) => f.mock.calls.length === 1)).toBe(true);
    // The keys' words are gone from the bar.
    expect(screen.queryByText(/Enter to send/)).toBeNull();
  }));

  it("stay shown while the model pill can give way, truncated to its least", () => withOs(() => {
    render(<Box utilities={utilities(vi.fn(), vi.fn())} picker={<View testID="pill" />} />);
    layOut(screen.getByTestId("composer-utilities-measure"), 136);
    layOut(screen.getByTestId("composer-utilities"), 136);
    layOut(screen.getByTestId("composer-spacer"), 0);
    // A wide pill, then one squeezed to its least (72): the row still fits, so nothing folds.
    for (const pill of [220, 72]) {
      layOut(screen.getByTestId("composer-picker"), pill);
      expect(within(screen.getByTestId("composer-utilities")).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Checkpoints", "Subagents (2)", "Attach"]);
      expect(screen.queryByLabelText(/More controls/)).toBeNull();
    }
    // Squeezed below its least, the bar truly cannot hold them: they fold.
    layOut(screen.getByTestId("composer-picker"), 30);
    expect(screen.getByLabelText("More controls, 2 subagents")).toBeTruthy();
  }));

  it("fold into one menu when the measured row does not fit, and unfold when it does", () => withOs(async () => {
    const review = vi.fn();
    const agents = vi.fn();
    render(<Box utilities={utilities(review, agents)} />);
    const row = screen.getByTestId("composer-utilities-measure");
    layOut(row, 136);
    layOut(screen.getByTestId("composer-utilities"), 136);
    layOut(screen.getByTestId("composer-spacer"), 0);
    expect(screen.queryByLabelText(/More controls/)).toBeNull();
    // Squeezed: the slot is narrower than the row and nothing is free.
    layOut(screen.getByTestId("composer-utilities"), 90);
    expect(screen.queryByRole("button", { name: "Checkpoints" })).toBeNull();
    fireEvent.click(button("More controls, 2 subagents"));
    // The menu opens over the button once its place on screen is measured.
    const menu = await screen.findByRole("menu", { name: "More controls" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["Checkpoints", "Subagents (2)", "Attach"]);
    expect(within(menu).getByText("Subagents (2)")).toBeTruthy();
    fireEvent.click(items[0]);
    expect(review).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    // Room again: the overflow button and the free space are wider than the row.
    layOut(screen.getByTestId("composer-utilities"), 44);
    layOut(screen.getByTestId("composer-spacer"), 120);
    expect(button("Checkpoints")).toBeTruthy();
    expect(screen.queryByLabelText(/More controls/)).toBeNull();
  }));
});

describe("the slash menu", () => {
  it("offers every command a paired browser gets, /compact among them and never /remote, and a pick fills the box", () => {
    render(<Box />);
    type("/");
    const menu = screen.getByLabelText("Commands");
    for (const c of ["/playtest", "/flow", "/action", "/compact"]) expect(within(menu).getByText(c)).toBeTruthy();
    expect(within(menu).queryByText("/remote")).toBeNull();
    type("/co");
    pressRow(screen.getByRole("menuitem", { name: "/compact" }));
    expect(box().value).toBe("/compact ");
    expect(screen.queryByLabelText("Commands")).toBeNull();
  });

  it("completes a flow's name after /flow", async () => {
    const flows: FlowListing[] = [{ name: "playtest", description: "Run the playtest" }, { name: "package" }];
    render(<Box flows={() => Promise.resolve(flows)} />);
    type("/flow pa");
    await settle();
    const menu = screen.getByLabelText("Flows");
    expect(within(menu).getByText("package")).toBeTruthy();
    expect(within(menu).queryByText("playtest")).toBeNull();
  });

  it("completes an action's name after /action", async () => {
    const actions: ActionListing[] = [{ name: "level.get_outliner", category: "level", method: "get_outliner", summary: "The level's actors" } as ActionListing];
    render(<Box actions={() => Promise.resolve(actions)} />);
    type("/action level.get");
    await settle();
    expect(within(screen.getByLabelText("Actions")).getByText("level.get_outliner")).toBeTruthy();
  });
});

const MATCHES: MentionMatch[] = [
  { kind: "asset", name: "BP_Door", type: "Blueprint", path: "/Game/Props/Doors/BP_Door.BP_Door", target: "/Game/Props/Doors/BP_Door.BP_Door" },
  { kind: "actor", name: "Front Door", type: "StaticMeshActor", path: "/Game/Maps/Cave.Cave:PersistentLevel.StaticMeshActor_12", target: "actor:/Game/Maps/Cave.Cave:PersistentLevel.StaticMeshActor_12" },
];

function searchOf(answer: (q: string) => MentionSearchResponse): MentionSearchFn & ReturnType<typeof vi.fn> {
  return vi.fn((r: { query: string }) => Promise.resolve(answer(r.query))) as never;
}

describe("the @-mention menu", () => {
  it("lists the matches with their kind, name, type and path, and a pick puts a token in the box shown as a chip", async () => {
    const search = searchOf((query) => ({ query, results: MATCHES, sources: { asset: "editor", actor: "editor", file: "disk" } }));
    render(<Box initial="Put a light over " mentions={search} />);
    type("Put a light over @Door");
    await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
    expect(search).toHaveBeenCalledWith({ query: "Door" }, expect.anything());
    const menu = screen.getByLabelText("Mentions");
    expect(within(menu).getByText("BP_Door")).toBeTruthy();
    expect(within(menu).getByText("Blueprint")).toBeTruthy();
    expect(within(menu).getByText("/Game/Props/Doors/BP_Door.BP_Door")).toBeTruthy();
    expect(within(menu).getByText("Actor")).toBeTruthy();
    const row = screen.getByRole("menuitem", { name: "Asset BP_Door" });
    pressRow(row);
    expect(box().value).toBe(`Put a light over ${mentionToken(MATCHES[0])} `);
    const chips = screen.getByLabelText("Mentioned");
    expect(within(chips).getByText("BP_Door")).toBeTruthy();
    fireEvent.click(button("Remove the mention of BP_Door"));
    expect(box().value).toBe("Put a light over ");
  });

  it("narrows to actors with @actor:, and says why when no editor can answer", async () => {
    const search = searchOf((query) => ({ query, results: [], sources: { actor: "unavailable" } }));
    render(<Box mentions={search} />);
    type("Put a light over @actor:Fro");
    await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
    expect(search).toHaveBeenCalledWith({ query: "Fro", kinds: ["actor"] }, expect.anything());
    expect(screen.getByText("Actors need the editor connected and not busy.")).toBeTruthy();
    expect(screen.queryByText(/No actors match/)).toBeNull();
  });

  it("says so when nothing matches, and asks for a name after a bare @", async () => {
    const search = searchOf((query) => ({ query, results: [], sources: { asset: "editor", actor: "editor", file: "disk" } }));
    render(<Box mentions={search} />);
    type("@");
    expect(screen.getByText("Type a name to find assets, actors or files.")).toBeTruthy();
    type("@Zebra");
    await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
    expect(screen.getByText("No assets, actors or files match Zebra.")).toBeTruthy();
  });

  it("draws a sent message's mentions as chips with their kind", () => {
    const text = `Swap the mesh on ${mentionToken(MATCHES[1])} for ${mentionToken(MATCHES[0])}`;
    renderInProject(<MentionText text={text} />);
    expect(screen.getByText("Front Door")).toBeTruthy();
    // The chip's asset name is a link now, its text broken at zero-width spaces between parts.
    expect(document.body.textContent?.replace(/​/g, "")).toContain("BP_Door");
    expect(screen.getByText("Actor")).toBeTruthy();
    expect(screen.getByText("Asset")).toBeTruthy();
    expect(screen.getByText(/Swap the mesh on/)).toBeTruthy();
  });
});

describe("PillRow", () => {
  it("draws nothing without pills; a tap clears the row and runs the pill", () => {
    const actions = { playtest: vi.fn() };
    const { container, rerender } = render(<PillRow pills={[]} actions={actions} onClear={() => undefined} />);
    expect(container.textContent).toBe("");
    const onClear = vi.fn();
    rerender(<PillRow pills={[{ id: "p", label: "Make playtest", run: (a) => a.playtest({ text: "", turn: 3 }) }]} actions={actions} onClear={onClear} />);
    expect(screen.getByLabelText("Suggestions")).toBeTruthy();
    fireEvent.click(button("Make playtest"));
    expect(onClear).toHaveBeenCalled();
    expect(actions.playtest).toHaveBeenCalledWith({ text: "", turn: 3 });
  });
});

/** The routes the launchers and pickers call, on the fake API. */
function api() {
  const a = fakeApi() as ReturnType<typeof fakeApi> & Record<string, ReturnType<typeof vi.fn>>;
  for (const n of ["flows", "planFlow", "actions", "describeAction", "uploadAttachment", "searchMentions"]) a[n] = vi.fn(() => new Promise(() => undefined));
  return a;
}

describe("FlowLauncher", () => {
  it("asks for a name after a bare /flow, offering the project's flows", async () => {
    const a = api();
    a.flows.mockResolvedValue({ flows: [{ name: "playtest" }, { name: "package" }] });
    renderInProject(<FlowLauncher text="/flow" run={vi.fn()} onClose={vi.fn()} />, a);
    await settle();
    expect(screen.getByText("Run a flow")).toBeTruthy();
    expect(screen.getByText("Name a flow after /flow.")).toBeTruthy();
    expect(button("package")).toBeTruthy();
  });

  it("names the closest flows to one that is not there", async () => {
    const a = api();
    a.flows.mockResolvedValue({ flows: [{ name: "playtest" }] });
    a.planFlow.mockResolvedValue({});
    renderInProject(<FlowLauncher text="/flow playtst" run={vi.fn()} onClose={vi.fn()} />, a);
    await settle();
    expect(screen.getByText("No flow named playtst.")).toBeTruthy();
    expect(screen.getByText("Closest:")).toBeTruthy();
    expect(button("playtest")).toBeTruthy();
  });

  it("runs a flow with no inputs at once, with the pairs typed after its name", async () => {
    const a = api();
    a.flows.mockResolvedValue({ flows: [{ name: "package" }] });
    a.planFlow.mockResolvedValue({ steps: [] });
    const run = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    renderInProject(<FlowLauncher text="/flow package target=win" run={run} onClose={onClose} />, a);
    await settle();
    expect(run).toHaveBeenCalledWith({ name: "package", params: { target: "win" } });
    await settle();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ActionLauncher", () => {
  it("says how to name an action after a bare /action", async () => {
    renderInProject(<ActionLauncher text="/action" run={vi.fn()} onClose={vi.fn()} />, api());
    await settle();
    expect(screen.getByText(/Name an action after \/action, as category.method/)).toBeTruthy();
  });

  it("runs an action that takes no parameters at once, in the catalog's spelling", async () => {
    const a = api();
    a.actions.mockResolvedValue({ actions: [{ name: "level.get_outliner", category: "level", method: "get_outliner" }] });
    a.describeAction.mockResolvedValue({ name: "level.get_outliner", params: [] });
    const run = vi.fn(() => Promise.resolve());
    renderInProject(<ActionLauncher text="/action Level.Get_Outliner" run={run} onClose={vi.fn()} />, a);
    await settle();
    await settle();
    expect(a.describeAction).toHaveBeenCalledWith("level.get_outliner");
    expect(run).toHaveBeenCalledWith({ category: "level", method: "get_outliner", args: {} });
  });
});

const settings = { provider: "anthropic", model: "sonnet-5.5", effort: "medium", route: "claude", connected: { claude: true } } as unknown as StudioSettings;
const catalog: ModelCatalog = {
  signedIn: { claude: true, chatgpt: false, studio: false } as ModelCatalog["signedIn"],
  routeOrder: ["claude", "key"] as unknown as ModelCatalog["routeOrder"],
  providers: [
    { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "sonnet-5.5", name: "Sonnet 5.5", signIns: ["claude"] }] },
    { id: "openai", name: "OpenAI", connected: false, source: "default", models: [{ id: "gpt-y", name: "GPT Y", signIns: ["chatgpt"] }] },
  ] as ModelCatalog["providers"],
} as ModelCatalog;

describe("ModelPicker", () => {
  it("in a narrow bar, one chip names the model and the effort; its menu lists the models and the effort", async () => {
    const a = api();
    a.models.mockResolvedValue(catalog);
    a.saveSettings.mockResolvedValue({ ...settings, effort: "high" });
    const onSettings = vi.fn();
    renderInProject(<BarTierContext.Provider value="merged"><ModelAndEffort settings={settings} onSettings={onSettings} /></BarTierContext.Provider>, a);
    await settle();
    await openPicker("Model and effort: Sonnet 5.5, Medium");
    expect(screen.getByText("Sonnet 5.5 · Medium")).toBeTruthy();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("Claude sign-in")).toBeTruthy();
    expect(screen.getAllByText("Connect on your computer")[0]).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    await settle();
    expect(a.saveSettings).toHaveBeenCalledWith({ effort: "high" });
    expect(onSettings).toHaveBeenCalled();
  });

  it("in the composer row, the pill opens the models and the effort in a sheet from the bottom of the screen", async () => {
    const a = api();
    a.models.mockResolvedValue(catalog);
    a.saveSettings.mockResolvedValue({ ...settings, effort: "high" });
    renderInProject(<ModelAndEffort pill settings={settings} onSettings={vi.fn()} />, a);
    await settle();
    await openPicker("Model and effort: Sonnet 5.5, Medium");
    const sheet = screen.getByLabelText("Model and effort");
    expect(within(sheet).getByText("Anthropic")).toBeTruthy();
    expect(within(sheet).getByRole("radio", { name: "High" })).toBeTruthy();
    // No menu placed beside the pill: nothing there to misplace.
    expect(screen.queryByLabelText("Close the menu")).toBeNull();
    fireEvent.click(within(sheet).getByRole("radio", { name: "High" }));
    await settle();
    expect(a.saveSettings).toHaveBeenCalledWith({ effort: "high" });
  });

  it("a model nothing connected runs says to connect it on the computer", async () => {
    const a = api();
    a.models.mockResolvedValue(catalog);
    renderInProject(<ModelPicker settings={settings} onSettings={vi.fn()} up />, a);
    await settle();
    await openPicker("Sonnet 5.5");
    // Greyed, and it says where it can be connected: the phone cannot add a sign-in or a key.
    expect(within(screen.getByRole("menuitem", { name: "GPT Y" })).getByText("Connect on your computer")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "GPT Y" }));
    expect(screen.getByText("Change this from Studio on the computer.")).toBeTruthy();
    expect(screen.getByText(/Use your own OpenAI API key instead/)).toBeTruthy();
  });

  it("picks a model that runs", async () => {
    const a = api();
    a.models.mockResolvedValue(catalog);
    a.saveSettings.mockResolvedValue(settings);
    renderInProject(<ModelPicker settings={settings} onSettings={vi.fn()} up />, a);
    await settle();
    await openPicker("Sonnet 5.5");
    fireEvent.click(screen.getByRole("menuitem", { name: "Sonnet 5.5" }));
    await settle();
    expect(a.saveSettings).toHaveBeenCalledWith({ provider: "anthropic", model: "sonnet-5.5" });
  });

  it("wide, the effort is its own control with its word", async () => {
    const a = api();
    a.models.mockResolvedValue(catalog);
    a.saveSettings.mockResolvedValue({ ...settings, effort: "max" });
    renderInProject(<EffortPicker settings={settings} onSettings={vi.fn()} />, a);
    expect(screen.getByText("Effort")).toBeTruthy();
    fireEvent.click(button("Effort: Medium"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Max" }));
    await settle();
    expect(a.saveSettings).toHaveBeenCalledWith({ effort: "max" });
  });
});

describe("useAttachments", () => {
  it("uploads each file as it is added, and refuses one too large", async () => {
    const a = api();
    a.uploadAttachment.mockResolvedValue({ id: "att1", name: "p.jpg", type: "image/jpeg", size: 3 });
    let hook: ReturnType<typeof useAttachments> | null = null;
    function Probe() {
      hook = useAttachments("s1");
      return null;
    }
    renderInProject(<Probe />, a);
    const files: PickedFile[] = [
      { uri: "file:///p.jpg", name: "p.jpg", type: "image/jpeg", size: 3, base64: "AAAA" },
      { uri: "file:///big", name: "big", type: "application/zip", size: 200 * 1024 * 1024 },
    ];
    act(() => hook!.add(files));
    await settle();
    expect(a.uploadAttachment).toHaveBeenCalledWith("s1", { name: "p.jpg", type: "image/jpeg", data: "AAAA" });
    expect(hook!.ready).toEqual([{ id: "att1", name: "p.jpg", type: "image/jpeg", size: 3 }]);
    expect(hook!.files[1].state).toBe("error");
    expect(hook!.files[1].error).toBe("larger than 100.0 MB");
  });
});
