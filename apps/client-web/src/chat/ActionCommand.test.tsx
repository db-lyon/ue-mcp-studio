// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { actionArgs, actionCommandText, actionFormFields, parseActionArgs, splitActionName, type ActionDescription, type ActionListing } from "@ue-mcp-studio/shared";

/** The agent: ue-mcp's catalog, and each action's parameters. */
const m = vi.hoisted(() => ({
  actions: vi.fn(async () => ({ actions: [] as ActionListing[] })),
  describeAction: vi.fn(async (_name: string): Promise<unknown> => ({})),
}));
vi.mock("../api", () => ({ api: m }));
import { ActionLauncher } from "./ActionCommand";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CATALOG: ActionListing[] = [
  { name: "level.place_actor", category: "level", method: "place_actor", summary: "Place an actor in the level.", effect: "mutate" },
  { name: "level.get_outliner", category: "level", method: "get_outliner", effect: "read" },
  { name: "level.get_selected", category: "level", method: "get_selected", effect: "read" },
  { name: "asset.delete", category: "asset", method: "delete", effect: "mutate", destructive: true },
];

/** level.place_actor as describe_action reports it, trimmed. */
const PLACE: ActionDescription = {
  tool: "level",
  action: "place_actor",
  description: "Place an actor in the level.",
  class: "mutate",
  params: [
    { name: "label", type: "string", required: false, description: "Actor label" },
    { name: "actorClass", type: "string", required: true, description: "Class name or path" },
    { name: "onConflict", type: "enum", required: false, enumValues: ["skip", "update", "error"] },
    { name: "location", type: "object", required: false, properties: { x: { type: "number", required: true }, y: { type: "number", required: true }, z: { type: "number", required: true } } },
    { name: "snap", type: "boolean", required: false },
    { name: "count", type: "integer", required: false, default: 1, minimum: 1, maximum: 100 },
  ],
};

const DELETE: ActionDescription = {
  tool: "asset",
  action: "delete",
  params: [
    { name: "assetPath", type: "string", required: false, alternativeGroup: 0 },
    { name: "assetPaths", type: "string[]", required: false, alternativeGroup: 0 },
  ],
  alternatives: [{ branches: [["assetPath"], ["assetPaths"]], required: true }],
};

function agent(described: Record<string, ActionDescription>) {
  m.actions.mockImplementation(async () => ({ actions: CATALOG }));
  m.describeAction.mockImplementation(async (name: string) => {
    if (!(name in described)) throw new Error(`Unknown action '${name}'.`);
    return described[name];
  });
}

describe("reading /action's text", () => {
  it("takes the name, then key=value pairs; whole quotes go, quotes inside JSON stay", () => {
    expect(parseActionArgs('level.place_actor actorClass=PointLight label="Key Light" location={"x":0,"y":0,"z":200} extra')).toEqual({
      name: "level.place_actor",
      values: { actorClass: "PointLight", label: "Key Light", location: '{"x":0,"y":0,"z":200}' },
      rest: ["extra"],
    });
    expect(parseActionArgs(`level.place_actor location='{"x": 1, "y": 2, "z": 3}'`).values.location).toBe('{"x": 1, "y": 2, "z": 3}');
    expect(parseActionArgs("")).toEqual({ name: "", values: {}, rest: [] });
  });

  it("splits category.method, and only that", () => {
    expect(splitActionName("level.place_actor")).toEqual({ category: "level", method: "place_actor" });
    expect(splitActionName("place_actor")).toBeNull();
    expect(splitActionName("a.b.c")).toBeNull();
  });

  it("writes a run back as a message parseActionArgs reads the same", () => {
    const args = { actorClass: "PointLight", label: "Key Light", location: { x: 0, y: 0, z: 200 }, snap: true };
    const text = actionCommandText("level", "place_actor", args);
    expect(text).toBe('/action level.place_actor actorClass=PointLight label="Key Light" location={"x":0,"y":0,"z":200} snap=true');
    const back = parseActionArgs(text.replace(/^\/action/, ""));
    expect(actionArgs({ ...PLACE, params: [] }, {}, back.values)).toEqual(args);
  });
});

describe("the form an action's parameters make", () => {
  it("puts required parameters first and gives each type its control", () => {
    const { fields, required } = actionFormFields(PLACE);
    expect(required).toEqual(["actorClass"]);
    expect(Object.keys(fields)[0]).toBe("actorClass");
    expect(fields.actorClass).toMatchObject({ type: "string", description: "Class name or path" });
    expect(fields.count).toMatchObject({ type: "integer", default: 1 });
    expect(fields.count.description).toContain("Range 1..100.");
    expect(fields.location.description).toContain("JSON: {x: number, y: number, z: number}.");
  });

  it("starts an optional enum or boolean with no default as Not set, so the action's own default holds", () => {
    const { fields } = actionFormFields(PLACE);
    expect(fields.onConflict).toMatchObject({ type: "string", enum: ["", "skip", "update", "error"], enumNames: ["Not set", "skip", "update", "error"] });
    expect(fields.snap).toMatchObject({ type: "string", enum: ["", "true", "false"] });
    expect(actionArgs(PLACE, { actorClass: "A", onConflict: "", snap: "" })).toEqual({ actorClass: "A" });
    expect(actionArgs(PLACE, { actorClass: "A", snap: "true", count: 3 })).toEqual({ actorClass: "A", snap: true, count: 3 });
  });

  it("says which parameters are a choice", () => {
    const { fields, required } = actionFormFields(DELETE);
    expect(required).toEqual([]);
    expect(fields.assetPath.description).toBe("Give this or assetPaths.");
    expect(fields.assetPaths.description).toContain("JSON: string[].");
    expect(actionArgs(DELETE, { assetPaths: '["/Game/A","/Game/B"]' })).toEqual({ assetPaths: ["/Game/A", "/Game/B"] });
  });
});

describe("the /action form", () => {
  it("is built from the action's parameters with the typed pairs in, and runs with typed values", async () => {
    agent({ "level.place_actor": PLACE });
    const run = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<ActionLauncher text='/action level.place_actor label="Key Light" count=4 extra=1' run={run} onClose={onClose} />);
    await screen.findByRole("group", { name: "Run action level.place_actor" });
    expect(m.describeAction).toHaveBeenCalledWith("level.place_actor");
    expect(screen.getByText("Place an actor in the level.")).toBeTruthy();
    expect((screen.getByLabelText(/^label/) as HTMLTextAreaElement).value).toBe("Key Light");
    expect((screen.getByLabelText(/^count/) as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText(/^onConflict/) as HTMLSelectElement).value).toBe("");
    // actorClass is required: Run waits for it.
    const go = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^actorClass/), { target: { value: "PointLight" } });
    fireEvent.change(screen.getByLabelText(/^location/), { target: { value: '{"x":0,"y":0,"z":200}' } });
    fireEvent.click(go);
    expect(run).toHaveBeenCalledWith({
      category: "level",
      method: "place_actor",
      args: { extra: 1, label: "Key Light", actorClass: "PointLight", count: 4, location: { x: 0, y: 0, z: 200 } },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("finds the catalog's name whatever case it was typed in", async () => {
    agent({ "level.place_actor": PLACE });
    render(<ActionLauncher text="/action Level.Place_Actor" run={vi.fn(async () => {})} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Run action level.place_actor" });
    expect(m.describeAction).toHaveBeenCalledWith("level.place_actor");
  });

  it("runs an action with no parameters at once", async () => {
    agent({ "level.get_selected": { tool: "level", action: "get_selected", params: [] } });
    const run = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<ActionLauncher text="/action level.get_selected" run={run} onClose={onClose} />);
    await waitFor(() => expect(run).toHaveBeenCalledWith({ category: "level", method: "get_selected", args: {} }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("says when no action has the name, with the closest, and a pick opens that one", async () => {
    agent({ "level.place_actor": PLACE });
    render(<ActionLauncher text="/action level.plce_actor" run={vi.fn(async () => {})} onClose={() => {}} />);
    expect(await screen.findByText("No action named level.plce_actor.")).toBeTruthy();
    expect(m.describeAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "level.place_actor" }));
    await screen.findByRole("group", { name: "Run action level.place_actor" });
    expect(screen.getByLabelText(/^actorClass/)).toBeTruthy();
  });

  it("asks for a name when none is given", async () => {
    agent({});
    render(<ActionLauncher text="/action" run={vi.fn(async () => {})} onClose={() => {}} />);
    expect(await screen.findByText(/Name an action after \/action/)).toBeTruthy();
    expect(m.actions).not.toHaveBeenCalled();
  });

  it("notes a destructive action, and shows why a run could not start", async () => {
    agent({ "asset.delete": DELETE });
    const run = vi.fn(async () => {
      throw new Error("a turn is already in progress");
    });
    render(<ActionLauncher text="/action asset.delete assetPath=/Game/Old" run={run} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Run action asset.delete" });
    expect(screen.getByText(/marks this action as deleting or overwriting/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(run).toHaveBeenCalledWith({ category: "asset", method: "delete", args: { assetPath: "/Game/Old" } });
    expect(await screen.findByText("a turn is already in progress")).toBeTruthy();
  });

  it("shows the agent's refusal of the describe", async () => {
    m.actions.mockImplementation(async () => ({ actions: CATALOG }));
    m.describeAction.mockImplementation(async () => {
      throw new Error("describe_action failed");
    });
    render(<ActionLauncher text="/action level.get_outliner" run={vi.fn(async () => {})} onClose={() => {}} />);
    expect(await screen.findByText("describe_action failed")).toBeTruthy();
  });
});
