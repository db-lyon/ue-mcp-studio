// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { closestNames, flowCommandText, flowFormFields, flowValue, parseFlowArgs, type FlowInput, type TranscriptEntry } from "@ue-mcp-studio/shared";

/** A daemon: the flows it lists, and the plan each answers with. */
const m = vi.hoisted(() => ({
  flows: vi.fn(async () => ({ flows: [] as Array<{ name: string; description?: string }> })),
  planFlow: vi.fn(async (_name: string): Promise<unknown> => ({})),
}));
vi.mock("../api", () => ({ api: m }));
import { FlowCard, FlowLauncher } from "./FlowCommand";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FLOWS = [
  { name: "rebuild", description: "Close, build and reopen the editor" },
  { name: "rebuild_lighting" },
  { name: "playtest" },
];
/** A step that reads an input, as ue-mcp#1512 reports it. */
const at = (path: string, task: string, flow = "rebuild") => ({ path, task, flow });
/** The plan's inputs, required first, as ue-mcp#1512 orders them. */
const INPUTS: FlowInput[] = [
  { name: "target", type: "string", required: true, steps: [at("2", "project.build"), at("3", "editor.start")] },
  { name: "clean", type: "boolean", default: false, required: false, steps: [at("2", "project.build")] },
  { name: "config", type: "string", enum: ["Development", "Shipping"], default: "Development", description: "Build configuration", required: false, steps: [at("2", "project.build")] },
  { name: "jobs", type: "integer", required: false, steps: [at("2", "project.build")] },
  { name: "maps", type: "array", required: false, steps: [at("3", "editor.start")] },
  { name: "mode", type: ["string", "number"], conflict: true, required: false, steps: [at("1", "editor.stop"), at("3", "editor.start")] },
];

function daemon(plans: Record<string, unknown>) {
  m.flows.mockImplementation(async () => ({ flows: FLOWS }));
  m.planFlow.mockImplementation(async (name: string) => {
    if (!(name in plans)) throw new Error(`Flow '${name}' not found`);
    return plans[name];
  });
}

describe("reading /flow's text", () => {
  it("takes the name, then key=value pairs, quotes keeping spaces", () => {
    expect(parseFlowArgs('rebuild clean=true target="Editor Win64" extra')).toEqual({ name: "rebuild", values: { clean: "true", target: "Editor Win64" }, rest: ["extra"] });
    expect(parseFlowArgs("")).toEqual({ name: "", values: {}, rest: [] });
  });

  it("reads text as the input's type, JSON where the type is open", () => {
    expect(flowValue("3", "integer")).toBe(3);
    expect(flowValue("true", "boolean")).toBe(true);
    expect(flowValue("007", "string")).toBe("007");
    expect(flowValue('["/Game/A"]', "array")).toEqual(["/Game/A"]);
    expect(flowValue("12", null)).toBe(12);
    expect(flowValue("hero", null)).toBe("hero");
    expect(flowValue("{broken", null)).toBe("{broken");
  });

  it("writes a run back as the message the chat shows", () => {
    expect(flowCommandText("rebuild", { clean: true, target: "Editor Win64" })).toBe('/flow rebuild clean=true target="Editor Win64"');
  });

  it("finds the closest names to one that is no flow", () => {
    expect(closestNames("rebild", FLOWS.map((f) => f.name))).toEqual(["rebuild"]);
    expect(closestNames("light", FLOWS.map((f) => f.name))).toEqual(["rebuild_lighting"]);
    expect(closestNames("zzzzzzzz", FLOWS.map((f) => f.name))).toEqual([]);
  });

  it("makes a field per input, defaults in, open types as JSON text", () => {
    const { fields, required } = flowFormFields(INPUTS);
    expect(required).toEqual(["target"]);
    expect(fields.clean).toMatchObject({ type: "boolean", default: false });
    expect(fields.config).toMatchObject({ type: "string", enum: ["Development", "Shipping"], default: "Development" });
    expect(fields.jobs).toMatchObject({ type: "integer" });
    expect(fields.maps).toMatchObject({ type: "string" });
    expect(fields.maps.description).toContain("JSON.");
    expect(fields.mode.description).toContain("Steps type it differently (string, number).");
    expect(fields.target.description).toBe("Read by steps 2 (project.build), 3 (editor.start).");
  });
});

describe("the /flow form", () => {
  it("is built from the plan's inputs, defaults filled in and the typed pairs over them, and runs with typed values", async () => {
    daemon({ rebuild: { steps: [{ name: "editor.stop" }], inputs: INPUTS } });
    const run = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<FlowLauncher text="/flow rebuild clean=true jobs=8 extra=1" run={run} onClose={onClose} />);
    await screen.findByRole("group", { name: "Run flow rebuild" });
    expect(m.planFlow).toHaveBeenCalledWith("rebuild");
    expect(screen.getByText("Close, build and reopen the editor")).toBeTruthy();
    expect((screen.getByLabelText(/^clean/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^config/) as HTMLSelectElement).value).toBe("Development");
    expect((screen.getByLabelText(/^jobs/) as HTMLInputElement).value).toBe("8");
    // target is required: Run waits for it.
    const go = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^target/), { target: { value: "Editor" } });
    fireEvent.change(screen.getByLabelText(/^maps/), { target: { value: '["/Game/Maps/Main"]' } });
    fireEvent.change(screen.getByLabelText(/^mode/), { target: { value: "2" } });
    fireEvent.click(go);
    expect(run).toHaveBeenCalledWith({
      name: "rebuild",
      params: { extra: 1, clean: true, config: "Development", target: "Editor", jobs: 8, maps: ["/Game/Maps/Main"], mode: 2 },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("runs a flow with no inputs at once", async () => {
    daemon({ playtest: { steps: [], inputs: [] } });
    const run = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<FlowLauncher text="/flow playtest" run={run} onClose={onClose} />);
    await waitFor(() => expect(run).toHaveBeenCalledWith({ name: "playtest", params: {} }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("says when no flow has the name, with the closest, and a pick opens that one", async () => {
    daemon({ rebuild: { steps: [], inputs: [{ name: "clean", type: "boolean", required: false, steps: [at("1", "project.build")] }] } });
    render(<FlowLauncher text="/flow rebild" run={vi.fn(async () => {})} onClose={() => {}} />);
    expect(await screen.findByText("No flow named rebild.")).toBeTruthy();
    expect(m.planFlow).toHaveBeenCalledWith("rebild");
    fireEvent.click(screen.getByRole("button", { name: "rebuild" }));
    await screen.findByRole("group", { name: "Run flow rebuild" });
    expect(screen.getByLabelText(/^clean/)).toBeTruthy();
  });

  it("lists the flows when none is named, and says when the run cannot start", async () => {
    daemon({ rebuild: { steps: [], inputs: [] } });
    const run = vi.fn(async () => {
      throw new Error("a turn is already in progress");
    });
    render(<FlowLauncher text="/flow" run={run} onClose={() => {}} />);
    expect(await screen.findByText("Name a flow after /flow.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "rebuild" }));
    expect(await screen.findByText("a turn is already in progress")).toBeTruthy();
  });

  it("shows the daemon's refusal of the plan", async () => {
    m.flows.mockImplementation(async () => ({ flows: FLOWS }));
    m.planFlow.mockImplementation(async () => {
      throw new Error("'flow.plan' was refused because a modal dialog is open");
    });
    render(<FlowLauncher text="/flow rebuild" run={vi.fn(async () => {})} onClose={() => {}} />);
    expect(await screen.findByText("'flow.plan' was refused because a modal dialog is open")).toBeTruthy();
  });
});

describe("the /flow form, against ue-mcp#1512's plan", () => {
  it("holds Run on playtest until its required target is given", async () => {
    daemon({ playtest: { steps: [], inputs: [
      { name: "target", type: "string", required: true, description: "What to test", steps: [at("1", "playtest.gather", "playtest")] },
      { name: "context", type: "string", required: false, steps: [at("1", "playtest.gather", "playtest")] },
    ] } });
    const run = vi.fn(async () => {});
    render(<FlowLauncher text="/flow playtest" run={run} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Run flow playtest" });
    const go = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^target/), { target: { value: "/Game/BP_Hero" } });
    fireEvent.click(go);
    expect(run).toHaveBeenCalledWith({ name: "playtest", params: { target: "/Game/BP_Hero" } });
  });

  it("nests a step-scoped flow's params under the steps that read them", async () => {
    daemon({ rebuild: { steps: [], definition: { options_scope: "step", steps: {} }, inputs: [
      { name: "target", type: "string", required: true, steps: [at("2", "project.build"), at("3", "editor.start")] },
      { name: "clean", type: "boolean", required: false, steps: [at("2", "project.build")] },
    ] } });
    const run = vi.fn(async () => {});
    render(<FlowLauncher text="/flow rebuild target=Editor clean=true" run={run} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Run flow rebuild" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(run).toHaveBeenCalledWith({ name: "rebuild", params: { 2: { target: "Editor", clean: true }, 3: { target: "Editor" } } });
  });

  it("says plainly when a step-scoped param is read by a nested step", async () => {
    daemon({ rebuild: { steps: [], options_scope: "step", inputs: [
      { name: "target", type: "string", required: true, steps: [at("2/1", "project.build", "child")] },
    ] } });
    const run = vi.fn(async () => {});
    render(<FlowLauncher text="/flow rebuild target=Editor" run={run} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Run flow rebuild" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText(/takes its params per step/)).toBeTruthy();
  });
});

describe("a /flow's card", () => {
  const at = "2026-10-24T10:00:00Z";
  it("lists the steps as they run", () => {
    const entry: TranscriptEntry = { kind: "flow", name: "rebuild", params: {}, state: "running", at, steps: [{ id: "1", name: "editor.stop", state: "done" }, { id: "2", name: "project.build", state: "running" }] };
    render(<FlowCard entry={entry as Extract<TranscriptEntry, { kind: "flow" }>} />);
    const card = screen.getByRole("status", { name: "Flow rebuild" });
    expect(card.textContent).toContain("Running");
    expect(screen.getAllByRole("listitem").map((li) => [li.textContent, li.className])).toEqual([["editor.stop", "done"], ["project.build", "running"]]);
  });

  it("ends with the summary, or the errors", () => {
    const done: TranscriptEntry = { kind: "flow", name: "rebuild", params: {}, state: "succeeded", duration: 1500, summary: "Flow 'rebuild' completed", at, steps: [] };
    render(<FlowCard entry={done as Extract<TranscriptEntry, { kind: "flow" }>} />);
    expect(screen.getByText("Succeeded in 1.5 s")).toBeTruthy();
    expect(screen.getByText("Flow 'rebuild' completed")).toBeTruthy();
    cleanup();
    const failed: TranscriptEntry = { kind: "flow", name: "rebuild", params: {}, state: "failed", errors: ["project.build: UBT exited 6"], at, steps: [{ id: "2", name: "project.build", state: "failed", error: "UBT exited 6" }] };
    render(<FlowCard entry={failed as Extract<TranscriptEntry, { kind: "flow" }>} />);
    expect(screen.getByText("project.build: UBT exited 6")).toBeTruthy();
    expect(screen.getByRole("status").className).toContain("bad");
  });
});
