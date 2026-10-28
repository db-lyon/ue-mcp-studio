// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { mentionToken, type MentionMatch, type MentionSearchRequest, type MentionSearchResponse } from "@ue-mcp-studio/shared";
import { Composer } from "./Composer";
import { MENTION_DEBOUNCE_MS, MentionText, type MentionSearchFn } from "./MentionMenu";
import type { PendingFile } from "./attachments";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BP: MentionMatch = { kind: "asset", name: "BP_SomeName", type: "Blueprint", path: "/Game/Blueprints/BP_SomeName.BP_SomeName", target: "/Game/Blueprints/BP_SomeName.BP_SomeName" };
const SM: MentionMatch = { kind: "asset", name: "SM_SomeNameRock", type: "StaticMesh", path: "/Game/Env/SM_SomeNameRock.SM_SomeNameRock", target: "/Game/Env/SM_SomeNameRock.SM_SomeNameRock" };
const CUBE: MentionMatch = { kind: "actor", name: "Cube", type: "StaticMeshActor", path: "/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2", target: "actor:/Game/Maps/Main.Main:PersistentLevel.StaticMeshActor_2" };
const INI: MentionMatch = { kind: "file", name: "DefaultGame.ini", type: "Config", path: "Config/DefaultGame.ini", target: "file:Config/DefaultGame.ini" };

/** A search answered from a fixed list, by the start of the name or anywhere in it; every call recorded with its signal. */
function fakeSearch(all: MentionMatch[] = [BP, SM, CUBE, INI], sources: MentionSearchResponse["sources"] = { asset: "editor", actor: "editor", file: "disk" }) {
  const calls: Array<{ request: MentionSearchRequest; signal: AbortSignal }> = [];
  const fn: MentionSearchFn = vi.fn(async (request: MentionSearchRequest, signal: AbortSignal) => {
    calls.push({ request, signal });
    const q = request.query.toLowerCase();
    const results = all.filter((m) => (!request.kinds || request.kinds.includes(m.kind)) && m.name.toLowerCase().includes(q));
    return { query: request.query, results, sources };
  });
  return { fn, calls };
}

/** The composer with its draft kept, as the chat keeps it. */
function Harness({ onSend, search }: { onSend: (text: string) => void; search?: MentionSearchFn }) {
  const [draft, setDraft] = useState("");
  return (
    <Composer
      draft={draft}
      onDraft={setDraft}
      onBlur={() => {}}
      placeholder="Ask"
      busy={false}
      canSend={draft.trim().length > 0}
      onSend={() => onSend(draft)}
      onStop={() => {}}
      files={[] as PendingFile[]}
      onAddFiles={() => {}}
      onRemoveFile={() => {}}
      picker={null}
      mentions={search}
    />
  );
}

const box = () => screen.getByPlaceholderText("Ask") as HTMLTextAreaElement;
const rows = () => screen.queryAllByRole("option").map((o) => ({
  name: o.querySelector(".mention-name")?.textContent,
  type: o.querySelector(".mention-type")?.textContent,
  path: o.querySelector(".mention-path")?.textContent,
  selected: o.getAttribute("aria-selected") === "true",
}));
/** Type into the box; jsdom puts the caret at the end of the new value. */
const type = (value: string) => fireEvent.change(box(), { target: { value } });
/** Let the debounce run out and the search answer. */
const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, MENTION_DEBOUNCE_MS + 30));
});

describe("the @-mention menu", () => {
  it("opens on @ and a name, and shows each match's name, type and path", async () => {
    const { fn, calls } = fakeSearch();
    render(<Harness onSend={() => {}} search={fn} />);
    type("rename @BP_SomeNa");
    await settle();
    expect(calls.map((c) => c.request)).toEqual([{ query: "BP_SomeNa" }]);
    expect(screen.getByRole("listbox", { name: "Mentions" })).toBeTruthy();
    expect(rows()).toEqual([{ name: "BP_SomeName", type: "Blueprint", path: BP.path, selected: true }]);
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id);
  });

  it("stays shut for an e-mail address, and without a search", async () => {
    const { fn, calls } = fakeSearch();
    render(<Harness onSend={() => {}} search={fn} />);
    type("mail me@example");
    await settle();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(calls).toEqual([]);
    cleanup();
    render(<Harness onSend={() => {}} />);
    type("@BP_Some");
    await settle();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("asks once typing pauses, and aborts the search it no longer wants", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: Array<{ request: MentionSearchRequest; signal: AbortSignal }> = [];
    const fn: MentionSearchFn = async (request, signal) => {
      calls.push({ request, signal });
      if (request.query === "Some") await gate;
      return { query: request.query, results: [BP, SM].filter((m) => m.name.includes(request.query)), sources: { asset: "editor" } };
    };
    render(<Harness onSend={() => {}} search={fn} />);
    type("@S");
    type("@So");
    type("@Som");
    type("@Some");
    await settle();
    // Only the pause after the last keystroke searched.
    expect(calls.map((c) => c.request.query)).toEqual(["Some"]);
    type("@SomeNameR");
    expect(calls[0].signal.aborted).toBe(true);
    await settle();
    release();
    await settle();
    expect(calls.map((c) => c.request.query)).toEqual(["Some", "SomeNameR"]);
    expect(rows().map((r) => r.name)).toEqual(["SM_SomeNameRock"]);
  });

  it("moves with Up and Down, wrapping", async () => {
    const { fn } = fakeSearch();
    render(<Harness onSend={() => {}} search={fn} />);
    type("@Some");
    await settle();
    expect(rows().map((r) => r.selected)).toEqual([true, false]);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(rows().map((r) => r.selected)).toEqual([false, true]);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(rows().map((r) => r.selected)).toEqual([true, false]);
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(rows().map((r) => r.selected)).toEqual([false, true]);
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
  });

  it("inserts with Enter: the token carries the full path, the caret goes after it, and nothing is sent", async () => {
    const onSend = vi.fn();
    const { fn } = fakeSearch();
    render(<Harness onSend={onSend} search={fn} />);
    type("open @BP_SomeNa");
    await settle();
    fireEvent.keyDown(box(), { key: "Enter" });
    const token = '[@BP_SomeName](/Game/Blueprints/BP_SomeName.BP_SomeName "Blueprint")';
    expect(box().value).toBe(`open ${token} `);
    expect(box().selectionStart).toBe(box().value.length);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    type(`${box().value}in the editor`);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith(`open ${token} in the editor`);
  });

  it("inserts with Tab or a click, keeping the text after the mention", async () => {
    const { fn } = fakeSearch();
    render(<Harness onSend={() => {}} search={fn} />);
    type("@Some");
    await settle();
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe(`${mentionToken(SM)} `);
    type("fix @Cu and the rest");
    // The caret right after "@Cu".
    box().setSelectionRange(7, 7);
    fireEvent.select(box());
    await settle();
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    expect(box().value).toBe(`fix ${mentionToken(CUBE)} and the rest`);
  });

  it("closes on Escape until the message changes, and Enter then sends", async () => {
    const onSend = vi.fn();
    const { fn } = fakeSearch();
    render(<Harness onSend={onSend} search={fn} />);
    type("@Some");
    await settle();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("@Some");
    type("@SomeN");
    await settle();
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });

  it("says so when nothing matches, and Enter sends the text as it is", async () => {
    const onSend = vi.fn();
    const { fn } = fakeSearch();
    render(<Harness onSend={onSend} search={fn} />);
    type("@Zebra");
    await settle();
    expect(screen.getByRole("status").textContent).toBe("No assets, actors or files match Zebra.");
    expect(screen.queryAllByRole("option")).toEqual([]);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("@Zebra");
  });

  it("asks for a name on a bare @, without searching", async () => {
    const { fn, calls } = fakeSearch();
    render(<Harness onSend={() => {}} search={fn} />);
    type("look at @");
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Type a name to find assets, actors or files.");
    expect(calls).toEqual([]);
  });

  it("narrows to actors with @actor:, and says when actors need an editor", async () => {
    const { fn, calls } = fakeSearch([], { actor: "unavailable" });
    render(<Harness onSend={() => {}} search={fn} />);
    type("@actor:Cu");
    await settle();
    expect(calls[0].request).toEqual({ query: "Cu", kinds: ["actor"] });
    expect(screen.getByText("Actors need a running editor.")).toBeTruthy();
    // Nothing could be asked, so the menu does not claim nothing matched.
    expect(screen.queryByText(/No actors match/)).toBeNull();
  });

  it("shows the mentions a message carries as chips, and removing one takes its token out", async () => {
    const { fn } = fakeSearch();
    render(<Harness onSend={() => {}} search={fn} />);
    type(`move ${mentionToken(CUBE)} next to ${mentionToken(BP)} now`);
    const chips = screen.getByLabelText("Mentioned");
    expect([...chips.querySelectorAll(".mention-chip-name")].map((c) => c.textContent)).toEqual(["Cube", "BP_SomeName"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove the mention of Cube" }));
    expect(box().value).toBe(`move next to ${mentionToken(BP)} now`);
  });
});

describe("a sent message's mentions", () => {
  it("draw as chips, the text around them kept", () => {
    render(<div data-testid="msg"><MentionText text={`open ${mentionToken(BP)} and ${mentionToken(INI)}.`} /></div>);
    const msg = screen.getByTestId("msg");
    expect(msg.textContent).toBe("open AssetBP_SomeName and FileDefaultGame.ini.");
    expect(msg.querySelector(".mention-chip.kind-file")?.getAttribute("title")).toBe("File: Config/DefaultGame.ini");
    // An asset's chip opens it in the editor.
    expect(screen.getByRole("button", { name: /BP_SomeName/ })).toBeTruthy();
  });

  it("leave a message with none as it is", () => {
    render(<div data-testid="msg"><MentionText text="write to me@example.com [not](a token)" /></div>);
    expect(screen.getByTestId("msg").textContent).toBe("write to me@example.com [not](a token)");
  });
});
