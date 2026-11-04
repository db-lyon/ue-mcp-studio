import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { FlowCard, FlowLauncher } from "../src/chat/FlowCommand";
import { FlowsSheet } from "../src/screens/flows/FlowsSheet";
import { fakeApi, renderInProject, settle } from "./helpers";

const FLOWS = [
  { name: "build-and-test", description: "Build, then test." },
  { name: "bake-lighting", description: "Build lighting for the open level." },
];
const PLAN = {
  inputs: [
    { name: "map", type: "string", description: "The level to open first.", required: true, steps: [{ path: "1", task: "level.open", flow: "bake-lighting" }] },
    { name: "quality", type: "string", enum: ["Preview", "Production"], default: "Production", required: false, steps: [] },
    { name: "save", type: "boolean", default: true, required: false, steps: [] },
  ],
};
const disabled = (text: string) => screen.getByText(text).closest("[aria-disabled]")?.getAttribute("aria-disabled") === "true";

function api() {
  const a = fakeApi();
  a.flows.mockResolvedValue({ flows: FLOWS });
  return a;
}

describe("FlowLauncher", () => {
  it("says it is reading the flow", () => {
    renderInProject(<FlowLauncher text="/flow bake-lighting" run={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Reading the flow")).toBeTruthy();
  });

  it("lists the project's flows when no name is given, and a pick reads that flow", async () => {
    const a = api();
    a.planFlow.mockResolvedValue(PLAN);
    renderInProject(<FlowLauncher text="/flow " run={vi.fn()} onClose={vi.fn()} />, a);
    await settle();
    expect(screen.getByText("Run a flow")).toBeTruthy();
    expect(screen.getByText("Name a flow after /flow.")).toBeTruthy();
    fireEvent.click(screen.getByText("bake-lighting"));
    await settle();
    expect(a.planFlow).toHaveBeenCalledWith("bake-lighting");
    expect(screen.getByText("Run flow bake-lighting")).toBeTruthy();
  });

  it("names the closest flows to a name that is none", async () => {
    const a = api();
    a.planFlow.mockRejectedValue(new Error("no such flow"));
    const close = vi.fn();
    renderInProject(<FlowLauncher text="/flow bake-lightng" run={vi.fn()} onClose={close} />, a);
    await settle();
    expect(screen.getByText("No flow named bake-lightng.")).toBeTruthy();
    expect(screen.getByText("Closest:")).toBeTruthy();
    expect(screen.getByText("bake-lighting")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
    expect(close).toHaveBeenCalled();
  });

  it("shows why the plan could not be read", async () => {
    const a = api();
    a.planFlow.mockRejectedValue(new Error("The editor is not connected."));
    renderInProject(<FlowLauncher text="/flow build-and-test" run={vi.fn()} onClose={vi.fn()} />, a);
    await settle();
    expect(screen.getByText("The editor is not connected.")).toBeTruthy();
  });

  it("runs a flow with no inputs at once, with the typed pairs", async () => {
    const a = api();
    a.planFlow.mockResolvedValue({ inputs: [] });
    const run = vi.fn(() => new Promise(() => undefined));
    renderInProject(<FlowLauncher text="/flow build-and-test target=Editor" run={run} onClose={vi.fn()} />, a);
    await settle();
    expect(run).toHaveBeenCalledWith({ name: "build-and-test", params: { target: "Editor" } });
    expect(screen.getByText("Starting")).toBeTruthy();
  });

  it("asks for a flow's inputs, prefilled from what was typed, and runs it", async () => {
    const a = api();
    a.planFlow.mockResolvedValue(PLAN);
    const run = vi.fn(() => Promise.resolve());
    const close = vi.fn();
    renderInProject(<FlowLauncher text="/flow bake-lighting map=/Game/Maps/L_Cave" run={run} onClose={close} />, a);
    await settle();
    expect(screen.getByText("Build lighting for the open level.")).toBeTruthy();
    expect((screen.getByLabelText("map") as HTMLTextAreaElement).value).toBe("/Game/Maps/L_Cave");
    expect((screen.getByLabelText("quality") as HTMLInputElement).value).toBe("Production");
    expect(disabled("Run")).toBe(false);
    fireEvent.click(screen.getByLabelText("save"));
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "Preview" } });
    fireEvent.click(screen.getByText("Run"));
    expect(run).toHaveBeenCalledWith({ name: "bake-lighting", params: { map: "/Game/Maps/L_Cave", quality: "Preview", save: false } });
    await settle();
    expect(close).toHaveBeenCalled();
  });

  it("holds Run until every required input is filled, and Cancel closes", async () => {
    const a = api();
    a.planFlow.mockResolvedValue(PLAN);
    const close = vi.fn();
    renderInProject(<FlowLauncher text="/flow bake-lighting" run={vi.fn()} onClose={close} />, a);
    await settle();
    expect(disabled("Run")).toBe(true);
    fireEvent.change(screen.getByLabelText("map"), { target: { value: "/Game/Maps/L_Lobby" } });
    expect(disabled("Run")).toBe(false);
    fireEvent.click(screen.getByText("Cancel"));
    expect(close).toHaveBeenCalled();
  });

  it("says why a run was refused and lets it be sent again", async () => {
    const a = api();
    a.planFlow.mockResolvedValue(PLAN);
    const run = vi.fn(() => Promise.reject(new Error("Enter your PIN to do this.")));
    renderInProject(<FlowLauncher text="/flow bake-lighting map=/Game/X" run={run} onClose={vi.fn()} />, a);
    await settle();
    fireEvent.click(screen.getByText("Run"));
    await settle();
    expect(screen.getByText("Enter your PIN to do this.")).toBeTruthy();
    expect(disabled("Run")).toBe(false);
  });

  it("says a step-scoped flow's param the form cannot address", async () => {
    const a = api();
    a.planFlow.mockResolvedValue({ options_scope: "step", inputs: [{ name: "map", type: "string", required: true, steps: [{ path: "2/1", task: "level.open", flow: "inner" }] }] });
    renderInProject(<FlowLauncher text="/flow bake-lighting map=/Game/X" run={vi.fn()} onClose={vi.fn()} />, a);
    await settle();
    fireEvent.click(screen.getByText("Run"));
    expect(screen.getByText(/takes its params per step/)).toBeTruthy();
  });
});

type FlowEntry = Extract<TranscriptEntry, { kind: "flow" }>;
const entry = (over: Partial<FlowEntry>): FlowEntry => ({ kind: "flow", name: "bake-lighting", params: {}, state: "running", steps: [], at: "2026-11-04T12:00:00Z", ...over });

describe("FlowCard", () => {
  it("shows the steps as they run, nested ones indented, skipped ones marked", () => {
    renderInProject(<FlowCard entry={entry({ steps: [{ id: "1", name: "level.open", state: "done" }, { id: "2/1", name: "lighting.check", depth: 1, state: "running" }, { id: "3", name: "level.save", state: "skipped" }] })} />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("level.open")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(screen.getByText(/skipped/)).toBeTruthy();
  });

  it("shows the duration and the summary when it succeeds", () => {
    renderInProject(<FlowCard entry={entry({ state: "succeeded", duration: 4_200, summary: "Built." })} />);
    expect(screen.getByText("Succeeded in 4.2 s")).toBeTruthy();
    expect(screen.getByText("Built.")).toBeTruthy();
  });

  it("shows a failed step's error and every error", () => {
    renderInProject(<FlowCard entry={entry({ state: "failed", duration: 1_000, steps: [{ id: "1", name: "level.build", state: "failed", error: "Out of memory." }], errors: ["level.build failed.", "level.save was not run."] })} />);
    expect(screen.getByText("Failed in 1.0 s")).toBeTruthy();
    expect(screen.getByText(/Out of memory\./)).toBeTruthy();
    expect(screen.getByText(/level.save was not run./)).toBeTruthy();
  });

  it("shows a single error as a line", () => {
    renderInProject(<FlowCard entry={entry({ state: "stopped", errors: ["Stopped by the user."] })} />);
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByText("Stopped by the user.")).toBeTruthy();
  });
});

describe("FlowsSheet", () => {
  it("lists the project's flows and runs the picked one in the session", async () => {
    const a = api();
    a.planFlow.mockResolvedValue({ inputs: [] });
    a.flow.mockResolvedValue({ sessionId: "s1" });
    const ran = vi.fn();
    renderInProject(<FlowsSheet open sessionId="s1" onClose={vi.fn()} onRan={ran} />, a);
    await settle();
    expect(screen.getByText("Build, then test.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Run flow build-and-test"));
    await settle();
    expect(a.flow).toHaveBeenCalledWith("s1", { name: "build-and-test", params: {} });
    await settle();
    expect(ran).toHaveBeenCalled();
  });

  it("says when the project has no flows, or they cannot be read", async () => {
    const a = fakeApi();
    a.flows.mockResolvedValue({ flows: [] });
    const { unmount } = renderInProject(<FlowsSheet open sessionId="s1" onClose={vi.fn()} />, a);
    await settle();
    expect(screen.getByText("This project has no flows.")).toBeTruthy();
    unmount();
    const b = fakeApi();
    b.flows.mockRejectedValue(new Error("ue-mcp is not running."));
    renderInProject(<FlowsSheet open sessionId="s1" onClose={vi.fn()} />, b);
    await settle();
    expect(screen.getByText("ue-mcp is not running.")).toBeTruthy();
  });
});
