// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ACTION_MENU_ROWS, SLASH_COMMANDS, actionNameQuery, matchActions, matchCommands, parseSlashCommand, slashQuery, type ActionListing, type FlowListing, type SlashCommand } from "@ue-mcp-studio/shared";
import { Composer } from "./Composer";
import type { PendingFile } from "./attachments";

afterEach(cleanup);

describe("the command registry", () => {
  it("has /playtest, /flow and /action", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["playtest", "flow", "action"]);
  });

  it("reads a command and its text from a message, and leaves any other message alone", () => {
    expect(parseSlashCommand("/playtest")).toEqual({ name: "playtest", args: "" });
    expect(parseSlashCommand("  /playtest  the double jump \n")).toEqual({ name: "playtest", args: "the double jump" });
    expect(parseSlashCommand("/playtest the door\nand the key")).toEqual({ name: "playtest", args: "the door\nand the key" });
    expect(parseSlashCommand("/playtesting")).toBeNull();
    expect(parseSlashCommand("/unknown thing")).toBeNull();
    expect(parseSlashCommand("please /playtest it")).toBeNull();
    expect(parseSlashCommand("/Game/Maps/Main is broken")).toBeNull();
    expect(parseSlashCommand("/flow rebuild clean=true")).toEqual({ name: "flow", args: "rebuild clean=true" });
    expect(parseSlashCommand("/action level.place_actor actorClass=PointLight")).toEqual({ name: "action", args: "level.place_actor actorClass=PointLight" });
  });

  it("knows a name is being typed only while the message is the slash and the start of a name", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/pla")).toBe("pla");
    expect(slashQuery("/playtest ")).toBeNull();
    expect(slashQuery("hi /pla")).toBeNull();
    expect(slashQuery("/pla\n")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  it("matches by the start of the name", () => {
    expect(matchCommands("").map((c) => c.name)).toEqual(["playtest", "flow", "action"]);
    expect(matchCommands("PLAY").map((c) => c.name)).toEqual(["playtest"]);
    expect(matchCommands("x")).toEqual([]);
  });
});

const COMMANDS: SlashCommand[] = [
  { name: "playtest", summary: "Draft a playtest" },
  { name: "plan", summary: "Plan something" },
  { name: "review", summary: "Review" },
];

/** The composer with its draft kept, as the chat keeps it. */
function Harness({ onSend, commands, flows, actions }: { onSend: (text: string) => void; commands?: SlashCommand[]; flows?: () => Promise<FlowListing[]>; actions?: () => Promise<ActionListing[]> }) {
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
      commands={commands}
      flows={flows}
      actions={actions}
    />
  );
}

const box = () => screen.getByPlaceholderText("Ask") as HTMLTextAreaElement;
const options = () => screen.queryAllByRole("option").map((o) => ({ text: o.querySelector(".slash-name")?.textContent, selected: o.getAttribute("aria-selected") === "true" }));

describe("the slash menu", () => {
  it("opens on / at the start of the message and narrows as the name is typed", () => {
    render(<Harness onSend={() => {}} commands={COMMANDS} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box(), { target: { value: "/" } });
    expect(options().map((o) => o.text)).toEqual(["/playtest", "/plan", "/review"]);
    fireEvent.change(box(), { target: { value: "/pla" } });
    expect(options().map((o) => o.text)).toEqual(["/playtest", "/plan"]);
    fireEvent.change(box(), { target: { value: "/zzz" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box(), { target: { value: "say /pla" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves with the arrow keys, wrapping, and points the text box at the option in focus", () => {
    render(<Harness onSend={() => {}} commands={COMMANDS} />);
    fireEvent.change(box(), { target: { value: "/" } });
    expect(options().map((o) => o.selected)).toEqual([true, false, false]);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(options().map((o) => o.selected)).toEqual([false, true, false]);
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(options().map((o) => o.selected)).toEqual([false, false, true]);
  });

  it("picks with Enter, which puts the command in the message without sending it; the next Enter sends", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} commands={COMMANDS} />);
    fireEvent.change(box(), { target: { value: "/p" } });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("/plan ");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/plan ");
  });

  it("picks with Tab or a click, and Escape closes it until the message changes", () => {
    render(<Harness onSend={() => {}} commands={COMMANDS} />);
    fireEvent.change(box(), { target: { value: "/r" } });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("/review ");
    fireEvent.change(box(), { target: { value: "/" } });
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    expect(box().value).toBe("/playtest ");
    fireEvent.change(box(), { target: { value: "/" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box(), { target: { value: "/p" } });
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });

  it("offers the registry's commands by default", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(box(), { target: { value: "/" } });
    expect(options()).toEqual([{ text: "/playtest", selected: true }, { text: "/flow", selected: false }, { text: "/action", selected: false }]);
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.change(box(), { target: { value: "/playtest the door opens" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/playtest the door opens");
  });
});

describe("/flow's name", () => {
  const FLOWS: FlowListing[] = [
    { name: "rebuild", description: "Close, build and reopen the editor" },
    { name: "playtest", description: "Draft a playtest" },
    { name: "rebuild_lighting" },
  ];

  it("completes from the daemon's flows, fetched when the menu opens, names that start with it first", async () => {
    const flows = vi.fn(async () => FLOWS);
    render(<Harness onSend={() => {}} flows={flows} />);
    fireEvent.change(box(), { target: { value: "/flow" } });
    expect(flows).not.toHaveBeenCalled();
    await act(async () => fireEvent.change(box(), { target: { value: "/flow " } }));
    expect(flows).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Flows" })).toBeTruthy();
    expect(options().map((o) => o.text)).toEqual(["rebuild", "playtest", "rebuild_lighting"]);
    expect(screen.getByText("Close, build and reopen the editor")).toBeTruthy();
    fireEvent.change(box(), { target: { value: "/flow light" } });
    expect(options().map((o) => o.text)).toEqual(["rebuild_lighting"]);
    fireEvent.change(box(), { target: { value: "/flow re" } });
    expect(flows).toHaveBeenCalledTimes(1);
    expect(options().map((o) => o.text)).toEqual(["rebuild", "rebuild_lighting"]);
  });

  it("puts the picked name in the message, ready for its pairs, and the next Enter sends", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} flows={async () => FLOWS} />);
    await act(async () => fireEvent.change(box(), { target: { value: "/flow reb" } }));
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("/flow rebuild_lighting ");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/flow rebuild_lighting ");
  });

  it("stays shut once the name is typed out, so Enter sends", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} flows={async () => FLOWS} />);
    await act(async () => fireEvent.change(box(), { target: { value: "/flow playtest" } }));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/flow playtest");
  });
});

describe("/action's name", () => {
  const A = (name: string, summary?: string): ActionListing => {
    const [category, method] = name.split(".");
    return { name, category, method, ...(summary ? { summary } : {}), effect: "mutate" };
  };
  const ACTIONS: ActionListing[] = [
    A("asset.delete", "Delete assets"),
    A("level.get_outliner", "List the level's actors"),
    A("level.place_actor", "Place an actor in the level"),
    A("level.place_actors_batch", "Place many actors"),
    A("blueprint.place_node"),
    A("level.spawn_light"),
  ];
  /** A catalog the size of ue-mcp's. */
  const MANY: ActionListing[] = Array.from({ length: 2200 }, (_, i) => A(`cat${i % 30}.action_${i}`, `Action ${i}`));

  it("knows the name is being typed until it is followed by anything", () => {
    expect(actionNameQuery("/action ")).toBe("");
    expect(actionNameQuery("/action level.pl")).toBe("level.pl");
    expect(actionNameQuery("/action level.place_actor actorClass=X")).toBeNull();
    expect(actionNameQuery("/actions")).toBeNull();
  });

  it("ranks the exact name, then names that start with it, methods that start with it, names that hold it, then every word", () => {
    expect(matchActions("level.place_actor", ACTIONS).map((a) => a.name)).toEqual(["level.place_actor", "level.place_actors_batch"]);
    expect(matchActions("place", ACTIONS).map((a) => a.name)).toEqual(["level.place_actor", "level.place_actors_batch", "blueprint.place_node"]);
    expect(matchActions("LEVEL.", ACTIONS).map((a) => a.name)).toEqual(["level.get_outliner", "level.place_actor", "level.place_actors_batch", "level.spawn_light"]);
    expect(matchActions("outliner", ACTIONS).map((a) => a.name)).toEqual(["level.get_outliner"]);
    expect(matchActions("level_light", ACTIONS).map((a) => a.name)).toEqual(["level.spawn_light"]);
    expect(matchActions("zzz", ACTIONS)).toEqual([]);
  });

  it("caps the rows however many match, and filters ue-mcp's whole catalog fast", () => {
    expect(matchActions("", MANY)).toHaveLength(ACTION_MENU_ROWS);
    expect(matchActions("action_1", MANY, 10)).toHaveLength(10);
    const t = performance.now();
    for (let i = 0; i < 50; i++) matchActions(`cat${i % 30}.action_${i}`, MANY);
    expect((performance.now() - t) / 50).toBeLessThan(10);
  });

  it("completes from the catalog, fetched when the menu opens, with each action's line", async () => {
    const actions = vi.fn(async () => ACTIONS);
    render(<Harness onSend={() => {}} actions={actions} />);
    fireEvent.change(box(), { target: { value: "/action" } });
    expect(actions).not.toHaveBeenCalled();
    await act(async () => fireEvent.change(box(), { target: { value: "/action " } }));
    expect(actions).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Actions" })).toBeTruthy();
    fireEvent.change(box(), { target: { value: "/action place" } });
    expect(options().map((o) => o.text)).toEqual(["level.place_actor", "level.place_actors_batch", "blueprint.place_node"]);
    expect(screen.getByText("Place an actor in the level")).toBeTruthy();
    expect(actions).toHaveBeenCalledTimes(1);
  });

  it("shows at most the capped rows of a full catalog", async () => {
    render(<Harness onSend={() => {}} actions={async () => MANY} />);
    await act(async () => fireEvent.change(box(), { target: { value: "/action " } }));
    expect(options()).toHaveLength(ACTION_MENU_ROWS);
    fireEvent.change(box(), { target: { value: "/action cat7.action_1" } });
    const shown = options().map((o) => o.text ?? "");
    const own = MANY.filter((a) => a.name.startsWith("cat7.action_1")).map((a) => a.name);
    // Those that start with it, then those holding each of its words (cat7.action_217).
    expect(shown.slice(0, own.length)).toEqual(own);
    expect(shown.length).toBeGreaterThan(own.length);
    expect(shown.length).toBeLessThanOrEqual(ACTION_MENU_ROWS);
    expect(shown.every((n) => n.startsWith("cat7.action_") && n.includes("1"))).toBe(true);
  });

  it("puts the picked name in the message, ready for its pairs, and stays shut once the name is typed out", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} actions={async () => ACTIONS} />);
    await act(async () => fireEvent.change(box(), { target: { value: "/action level.pl" } }));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("/action level.place_actor ");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box(), { target: { value: "/action level.place_actor" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/action level.place_actor");
  });
});
