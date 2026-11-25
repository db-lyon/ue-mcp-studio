// @vitest-environment jsdom
/**
 * The playtest editor on the hub: New playtest from the Library and a goal,
 * picking a value, ue-mcp's finding on its field with a one-click fix,
 * saving (create, or update for a saved one), reordering from the keyboard,
 * and asking before unsaved changes are left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { HubOverview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  hub: {
    overview: vi.fn(), check: vi.fn(), runs: vi.fn(), runCheck: vi.fn(), addChecks: vi.fn(), plan: vi.fn(), resultsUrl: (id: string) => `/r/${id}`,
  },
  drafting: { catalog: vi.fn(), script: vi.fn(), validate: vi.fn(), create: vi.fn(), save: vi.fn() },
  newSession: vi.fn(),
  playtest: vi.fn(),
}));
vi.mock("../../api", () => ({ api: { hub: m.hub, drafting: m.drafting, newSession: m.newSession, playtest: m.playtest, qaCaptureUrl: () => "", settings: () => new Promise(() => {}) } }));
import { HubView } from "./Hub";
import type { HubData } from "./state";
import { hubFixture } from "./test-data";

const CATALOG = {
  values: {
    pawn: { class: "/Game/BP_Hero.BP_Hero_C" },
    pawn_channels: ["pos_z"],
    values: [{ path: "JumpCurrentCount", kind: "integer", type: "int32" }, { path: "bIsCrouched", kind: "boolean", type: "bool" }],
    actors: ["BP_Door"],
    widgets: ["WBP_Pause"],
  },
  inputActions: ["/Game/Input/IA_Jump"],
  levels: [{ path: "/Game/Maps/Arena", name: "Arena" }],
  currentLevel: "/Game/Maps/Arena",
  gaps: [],
};

function Harness({ start }: { start: HubOverview }) {
  const [overview, setOverview] = useState<HubOverview | null>(start);
  const data: HubData = { overview, error: null, version: 0, reload: () => {}, patch: (f) => setOverview((o) => (o ? f(o) : o)) };
  return <HubView data={data} narrow={false} onOpenChat={() => {}} />;
}
const heading = () => screen.getByRole("heading", { level: 1 });

/** Pick a value in the step's value picker by typing part of it. */
async function pickValue(scope: HTMLElement, typed: string, option: RegExp) {
  fireEvent.click(within(scope).getByRole("button", { name: /Value/ }));
  fireEvent.change(screen.getByRole("combobox", { name: /Search values/ }), { target: { value: typed } });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  window.location.hash = "#/playtests/checks";
  for (const group of [m.hub, m.drafting]) for (const f of Object.values(group)) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  m.drafting.catalog.mockResolvedValue(CATALOG);
  m.drafting.validate.mockResolvedValue({ valid: true, errors: [] });
  m.drafting.create.mockImplementation(async (p: { name: string }) => ({ path: `/Game/PIEStudio/Scripts/${p.name}`, warnings: [] }));
  m.drafting.save.mockResolvedValue({ script: "/Game/Tests/Jump" });
  m.hub.check.mockImplementation(async (id: string) => ({ state: { ...hubFixture().checks[2], id, name: id.split("/").pop(), missing: false }, runs: [], more: false, script: null }));
  m.hub.runCheck.mockResolvedValue({ plan: { id: "p", items: [{}] } });
  m.hub.addChecks.mockResolvedValue({ goal: {} });
  try {
    window.sessionStorage.clear();
  } catch {
    // No storage in this environment.
  }
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("a new playtest", () => {
  it("is written from the Library: name, a value, a target, then Save creates it and opens it", async () => {
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /New script clip/ }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    expect(window.location.hash).toBe("#/playtests/checks/new");
    fireEvent.change(name, { target: { value: "PT Jump" } });
    expect(screen.getByText("/Game/PIEStudio/Scripts/PT_Jump")).toBeTruthy();
    const step = document.querySelector<HTMLElement>(".hub-draft-step")!;
    await pickValue(step, "jcc", /JumpCurrentCount/);
    // An integer starts on equals; its operator list is a number's.
    const op = within(step).getByRole("combobox", { name: "How it is checked" }) as HTMLSelectElement;
    expect([...op.options].map((o) => o.text)).toEqual(["is greater than", "is less than", "equals", "increases", "decreases"]);
    fireEvent.change(op, { target: { value: "gt" } });
    fireEvent.change(within(step).getByRole("textbox", { name: "Target" }), { target: { value: "0" } });
    expect(step.querySelector(".hub-draft-sentence")!.textContent).toBe("JumpCurrentCount is greater than 0 within 5 s");
    await waitFor(() => expect(m.drafting.validate).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.drafting.create).toHaveBeenCalledTimes(1));
    expect(m.drafting.create.mock.calls[0][0]).toEqual({
      name: "PT_Jump",
      map: "/Game/Maps/Arena",
      manual_only: false,
      steps: [{ instruction: "JumpCurrentCount is greater than 0 within 5 s", judge: "auto", expect: { value: "JumpCurrentCount", op: "gt", target: 0 } }],
    });
    await waitFor(() => expect(window.location.hash).toBe(`#/playtests/checks/${encodeURIComponent("script:/Game/PIEStudio/Scripts/PT_Jump")}`));
    expect(m.hub.runCheck).not.toHaveBeenCalled();
  });

  it("asks for what is missing on Save instead of saving", async () => {
    window.location.hash = "#/playtests/checks/new";
    render(<Harness start={hubFixture()} />);
    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Name the clip")).toBeTruthy();
    expect(screen.getByText("Choose a value to check")).toBeTruthy();
    expect(m.drafting.create).not.toHaveBeenCalled();
  });

  it("from a goal, joins that goal, and Save and run starts it", async () => {
    window.location.hash = "#/playtests/goals/movement/new";
    render(<Harness start={hubFixture()} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "PT_Crouch" } });
    expect(screen.getByText("Adds to Movement feels right")).toBeTruthy();
    await pickValue(document.querySelector<HTMLElement>(".hub-draft-step")!, "crouch", /bIsCrouched/);
    fireEvent.click(screen.getByRole("button", { name: /Save and run/ }));
    await waitFor(() => expect(m.drafting.create).toHaveBeenCalled());
    await waitFor(() => expect(m.hub.runCheck).toHaveBeenCalledWith("script:/Game/PIEStudio/Scripts/PT_Crouch"));
    expect(m.hub.addChecks).toHaveBeenCalledWith("movement", [{ kind: "script", target: "/Game/PIEStudio/Scripts/PT_Crouch" }]);
    expect(m.drafting.create.mock.calls[0][0].steps[0].expect).toEqual({ value: "bIsCrouched", op: "eq", target: true });
  });

  it("puts ue-mcp's finding on the value it is about, and its candidate fixes it in one click", async () => {
    m.drafting.validate.mockImplementation(async (p: { steps: Array<{ expect?: { value: string } }> }) => (p.steps[0].expect?.value === "JumpCount"
      ? { valid: false, errors: [{ step: 0, field: "expect.value", message: "steps[0].expect.value: 'JumpCount' cannot be read: BP_Hero has no property named JumpCount", candidates: ["JumpCurrentCount"] }] }
      : { valid: true, errors: [] }));
    window.location.hash = "#/playtests/checks/new";
    render(<Harness start={hubFixture()} />);
    await screen.findByRole("textbox", { name: "Name" });
    const step = document.querySelector<HTMLElement>(".hub-draft-step")!;
    fireEvent.click(within(step).getByRole("button", { name: /Value/ }));
    fireEvent.change(screen.getByRole("combobox", { name: /Search values/ }), { target: { value: "JumpCount" } });
    fireEvent.click(screen.getByRole("option", { name: /Use "JumpCount"/ }));
    const finding = await screen.findByText("'JumpCount' cannot be read: BP_Hero has no property named JumpCount", {}, { timeout: 3000 });
    expect(step.querySelector(".hub-draft-check .hub-draft-pick")!.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: "It exists only in PIE" })).toBeTruthy();
    fireEvent.click(within(finding.closest(".hub-draft-problem") as HTMLElement).getByRole("button", { name: "JumpCurrentCount" }));
    await waitFor(() => expect(screen.queryByText(/cannot be read/)).toBeNull());
    // The operator chosen for the typed value still suits the fixed one, so it stays.
    expect(step.querySelector(".hub-draft-sentence")!.textContent).toBe("JumpCurrentCount is greater than a number within 5 s");
  });

  it("moves a step with Alt and the arrow keys", async () => {
    window.location.hash = "#/playtests/checks/new";
    render(<Harness start={hubFixture()} />);
    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("button", { name: /Check the viewport/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "What to look for" }), { target: { value: "Looks right" } });
    const sentences = () => [...document.querySelectorAll(".hub-draft-sentence")].map((s) => s.textContent);
    expect(sentences()[1]).toBe("A person or an agent watches: Looks right");
    fireEvent.keyDown(screen.getAllByRole("button", { expanded: true })[0], { key: "ArrowUp", altKey: true });
    expect(sentences()[0]).toBe("A person or an agent watches: Looks right");
    expect(screen.getByText("Moved to step 1")).toBeTruthy();
  });

  it("asks before leaving unsaved changes, and stays on Keep editing", async () => {
    window.location.hash = "#/playtests/checks/new";
    render(<Harness start={hubFixture()} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "PT_Half" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard your changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    // Back in the browser asks too, and puts the address back.
    act(() => {
      window.location.hash = "#/playtests/checks";
    });
    const again = await screen.findByRole("dialog", { name: "Discard your changes?" });
    expect(window.location.hash).toBe("#/playtests/checks/new");
    fireEvent.click(within(again).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(heading().textContent).toBe("Clips"));
  });
});

describe("a saved playtest", () => {
  it("opens from Edit steps in the same editor, keeps what it does not draw, and saves as an update", async () => {
    m.drafting.script.mockResolvedValue({
      script: { path: "/Game/Tests/Jump", name: "Jump", map: "/Game/Maps/Arena", default_within_ms: 5000, steps: [
        { instruction: "Jump on the log", judge: "auto", arrange: [{ kind: "set", target: "BP_Door", path: "Open", value: 0 }], act: [{ press: { action: "/Game/Input/IA_Jump" } }], expect: { value: "pos_z", op: "increasing", within_ms: 800 } },
        { instruction: "Lands cleanly", judge: "manual" },
      ] },
      players: {},
    });
    window.location.hash = `#/playtests/checks/${encodeURIComponent("script:/Game/Tests/Jump")}/edit`;
    render(<Harness start={hubFixture()} />);
    await waitFor(() => expect(document.querySelector(".hub-draft-sentence")?.textContent).toBe("Press Jump, then pos_z increases within 0.8 s"));
    expect(heading().textContent).toBe("Jump");
    expect(screen.getByText("Also sets up 1 thing before it starts, kept as written.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Time limit in seconds" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.drafting.save).toHaveBeenCalledTimes(1));
    const [path, payload] = m.drafting.save.mock.calls[0];
    expect(path).toBe("/Game/Tests/Jump");
    expect(payload.steps[0]).toEqual({ instruction: "Jump on the log", judge: "auto", arrange: [{ kind: "set", target: "BP_Door", path: "Open", value: 0 }], act: [{ press: { action: "/Game/Input/IA_Jump" } }], expect: { value: "pos_z", op: "increasing", within_ms: 1000 } });
    expect(payload.steps[1]).toEqual({ instruction: "Lands cleanly", judge: "manual" });
    expect(m.drafting.create).not.toHaveBeenCalled();
    await waitFor(() => expect(window.location.hash).toBe(`#/playtests/checks/${encodeURIComponent("script:/Game/Tests/Jump")}`));
  });
});
