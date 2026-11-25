// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { HubOverview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  del: vi.fn(),
  open: vi.fn(async () => ({})),
  agentSettings: vi.fn(),
  hub: {
    overview: vi.fn(), verdict: vi.fn(), plan: vi.fn(), runCheck: vi.fn(), createGoal: vi.fn(), updateGoal: vi.fn(), check: vi.fn(), run: vi.fn(),
    runs: vi.fn(), addChecks: vi.fn(), removeCheck: vi.fn(), fix: vi.fn(), writePlaytests: vi.fn(), resultsUrl: (id: string) => `/r/${id}`,
    addRequire: vi.fn(), removeRequire: vi.fn(), orderRequires: vi.fn(), orderChecks: vi.fn(), cancelPlan: vi.fn(), pause: vi.fn(),
    deleteGoal: vi.fn(),
    movePlan: vi.fn(), createSchedule: vi.fn(), updateSchedule: vi.fn(), deleteSchedule: vi.fn(),
  },
}));
vi.mock("../../api", () => ({ ApiError: class extends Error {}, api: { hub: m.hub, openAsset: m.open, qaCaptureUrl: () => "", qaPlaytestDelete: m.del, settings: () => new Promise(() => {}), agentSettings: () => m.agentSettings() } }));
import { HubView } from "./Hub";
import type { HubData } from "./state";
import { hubFixture } from "./test-data";

function Harness({ start, narrow = false, onOpenChat = () => {}, canDeleteGoals = false }: { start: HubOverview; narrow?: boolean; onOpenChat?: (s: string, r?: string) => void; canDeleteGoals?: boolean }) {
  const [overview, setOverview] = useState<HubOverview | null>(start);
  const data: HubData = { overview, error: null, version: 0, reload: () => {}, patch: (f) => setOverview((o) => (o ? f(o) : o)) };
  return <HubView data={data} narrow={narrow} onOpenChat={onOpenChat} canDeleteGoals={canDeleteGoals} />;
}

const key = (k: string, o: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(document.body, { key: k, ...o });
const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

beforeEach(() => {
  m.del.mockReset();
  m.agentSettings.mockReset();
  m.agentSettings.mockResolvedValue({ agentFixes: true });
  window.location.hash = "#/playtests";
  for (const f of Object.values(m.hub)) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  m.hub.plan.mockResolvedValue({ plan: { id: "p1", title: "Movement feels right", items: [{}, {}] } });
  m.hub.runCheck.mockResolvedValue({ plan: { id: "p2", items: [{}] } });
  m.hub.verdict.mockResolvedValue({ run: {} });
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("hub routes", () => {
  it("opens the screen the hash names and follows Back and Forward", async () => {
    window.location.hash = "#/playtests/queue";
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Queue");
    act(() => {
      window.location.hash = "#/playtests/goals/movement";
    });
    await waitFor(() => expect(heading()).toBe("Movement feels right"));
    act(() => {
      window.location.hash = "#/playtests/checks";
    });
    await waitFor(() => expect(heading()).toBe("Playtests"));
  });

  it("moves between screens from the rail as links, each with its own URL", async () => {
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Overview");
    const rail = screen.getByRole("navigation", { name: "Playtests" });
    const library = within(rail).getByText("Playtests").closest("a")!;
    expect(library.getAttribute("href")).toBe("#/playtests/checks");
    fireEvent.click(library);
    expect(window.location.hash).toBe("#/playtests/checks");
    expect(heading()).toBe("Playtests");
    // The rail does not list goals; the Goals screen does.
    expect(within(rail).queryByText("Tutorial completes")).toBeNull();
    const goals = within(rail).getByText("Goals").closest("a")!;
    expect(goals.getAttribute("href")).toBe("#/playtests/goals");
    fireEvent.click(goals);
    expect(heading()).toBe("Goals");
    fireEvent.click(screen.getByText("Tutorial completes"));
    expect(window.location.hash).toBe("#/playtests/goals/tutorial");
    // What was opened is now under Recent.
    expect(within(rail).getByText("Recent")).toBeTruthy();
    expect(within(rail).getByText("Tutorial completes").closest("a")?.getAttribute("href")).toBe("#/playtests/goals/tutorial");
  });

  it("searches and filters the Goals screen", () => {
    window.location.hash = "#/playtests/goals";
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Goals");
    const rows = () => Array.from(document.querySelectorAll(".hub-goal-row .hub-row-title")).map((e) => e.textContent);
    const all = rows();
    expect(all.length).toBeGreaterThan(1);
    fireEvent.change(screen.getByLabelText("Search goals"), { target: { value: all[0]!.slice(0, 4).toUpperCase() } });
    expect(rows()).toContain(all[0]);
    fireEvent.change(screen.getByLabelText("Search goals"), { target: { value: "zzzz-no-goal" } });
    expect(rows()).toEqual([]);
  });

  it("lists milestones apart from goals, and filters goals by milestone", () => {
    window.location.hash = "#/playtests/milestones";
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Milestones");
    const rows = () => Array.from(document.querySelectorAll(".hub-goal-row .hub-row-title")).map((e) => e.textContent);
    expect(rows()).toEqual(["Alpha"]);
    expect(screen.getByRole("button", { name: /New milestone/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search milestones"), { target: { value: "zzzz" } });
    expect(rows()).toEqual([]);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Playtests" })).getByText("Goals"));
    expect(rows()).not.toContain("Alpha");
    const pick = screen.getByLabelText("Milestone");
    fireEvent.change(pick, { target: { value: "alpha" } });
    expect(rows()).toHaveLength(2);
    fireEvent.change(pick, { target: { value: "none" } });
    expect(rows()).toEqual([]);
  });

  it("encodes a check's id in its URL and opens it", async () => {
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[0], runs: [], more: false, script: null });
    window.location.hash = "#/playtests/checks/" + encodeURIComponent("script:/Game/Tests/Jump");
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Jump");
    await waitFor(() => expect(m.hub.check).toHaveBeenCalledWith("script:/Game/Tests/Jump", { limit: 30 }));
  });

  it("draws a segmented bar instead of the rail when narrow", () => {
    render(<Harness start={hubFixture()} narrow />);
    const bar = screen.getByRole("navigation", { name: "Playtests" });
    expect(bar.classList.contains("hub-seg")).toBe(true);
    expect(["Overview", "Milestones", "Goals", "Playtests"].every((t) => within(bar).getByText(t))).toBe(true);
    expect(within(bar).getByText("Overview").closest("a")?.querySelector(".tab-count")?.textContent).toBe("2");
  });
});

describe("the keyboard", () => {
  it("jumps with g then a letter, and moves and opens with j, k and Enter", () => {
    render(<Harness start={hubFixture()} />);
    key("g");
    key("l");
    expect(heading()).toBe("Playtests");
    key("g");
    key("o");
    expect(heading()).toBe("Overview");
    const rows = () => Array.from(document.querySelectorAll(".hub-goal-row"));
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    key("j");
    expect(rows()[1].getAttribute("aria-current")).toBe("true");
    key("k");
    key("Enter");
    expect(heading()).toBe("Movement feels right");
  });

  it("runs the goal on screen with r", async () => {
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    key("r");
    await waitFor(() => expect(m.hub.plan).toHaveBeenCalledWith({ scope: { kind: "goal", goalId: "movement" } }));
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("leaves typing alone and lists every key with ?", () => {
    window.location.hash = "#/playtests/checks";
    render(<Harness start={hubFixture()} />);
    key("/");
    const box = screen.getByLabelText("Filter playtests");
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "g" });
    fireEvent.keyDown(box, { key: "i" });
    expect(heading()).toBe("Playtests");
    (box as HTMLInputElement).blur();
    key("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Needs attention", () => {
  it("lists on the Overview what waits for a person, each linking to where it is dealt with", () => {
    render(<Harness start={hubFixture()} />);
    const card = screen.getByRole("region", { name: "Needs attention" });
    expect(within(card).getByText("Fix stopped")).toBeTruthy();
    const regression = within(card).getByText("Jump failed after passing").closest("a")!;
    expect(regression.getAttribute("href")).toBe("#/playtests/runs/run-jump-2");
    // There is no Inbox any more: its old address is the Overview.
    act(() => {
      window.location.hash = "#/playtests/inbox";
    });
    expect(heading()).toBe("Overview");
  });
});

describe("the command palette", () => {
  it("opens with Ctrl+K and jumps to a goal by a few letters", () => {
    render(<Harness start={hubFixture()} />);
    key("k", { ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Search" });
    fireEvent.change(input, { target: { value: "tutor" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(heading()).toBe("Tutorial completes");
  });

  it("runs a goal from the palette", async () => {
    render(<Harness start={hubFixture()} />);
    key("k", { metaKey: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "run movement" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search" }), { key: "Enter" });
    await waitFor(() => expect(m.hub.plan).toHaveBeenCalledWith({ scope: { kind: "goal", goalId: "movement" } }));
  });
});

describe("the goal form", () => {
  it("needs a title, then creates the goal and opens it", async () => {
    m.hub.createGoal.mockResolvedValue({ goal: { id: "four-players-join", title: "Four players join" } });
    render(<Harness start={hubFixture()} />);
    key("c");
    const dialog = screen.getByRole("dialog", { name: "New goal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    expect(within(dialog).getByText("A goal needs a title.")).toBeTruthy();
    expect(m.hub.createGoal).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Four players join" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    await waitFor(() => expect(m.hub.createGoal).toHaveBeenCalledWith(expect.objectContaining({ title: "Four players join", acceptance: { stableRuns: 1, signOff: false } })));
    await waitFor(() => expect(window.location.hash).toBe("#/playtests/goals/four-players-join"));
  });

  it("offers the kind and done-when choices as radios", () => {
    render(<Harness start={hubFixture()} />);
    key("c");
    const dialog = screen.getByRole("dialog", { name: "New goal" });
    expect(within(dialog).getByRole("group", { name: "Kind" })).toBeTruthy();
    expect((within(dialog).getByRole("radio", { name: /^Goal/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("radio", { name: "When all its playtests pass" }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryByLabelText("Passing runs in a row")).toBeNull();
  });

  it("edits a goal with its values filled in", async () => {
    m.hub.updateGoal.mockResolvedValue({ goal: {} });
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit goal" });
    expect((within(dialog).getByLabelText("Owner") as HTMLInputElement).value).toBe("dana");
    const partOf = within(dialog).getByRole("group", { name: "Part of" });
    expect((within(partOf).getByLabelText("Alpha") as HTMLInputElement).checked).toBe(true);
    // Tutorial completes can hold it too; a goal it requires could not.
    fireEvent.click(within(partOf).getByLabelText("Tutorial completes"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.hub.updateGoal).toHaveBeenCalledWith("movement", expect.objectContaining({ owner: "dana", parents: ["alpha", "tutorial"], priority: "p1" })));
  });

  it("leaves out of Part of the goals this goal already requires", () => {
    window.location.hash = "#/playtests/goals/alpha";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const partOf = within(screen.getByRole("dialog", { name: "Edit goal" })).queryByRole("group", { name: "Part of" });
    expect(partOf).toBeNull();
  });
});

describe("the relationship graph", () => {
  /** Alpha and Beta both require Movement; Menu's check is in no goal. */
  const twoMilestones = (): HubOverview => {
    const o = hubFixture();
    const beta = { ...o.goals[0], goal: { ...o.goals[0].goal, id: "beta", title: "Beta", due: "2027-01-01", requires: [{ goal: "movement" }] }, requires: [{ goal: "movement", required: true, status: "failing" as const }] };
    o.goals = [...o.goals, beta];
    o.goals[1] = { ...o.goals[1], parents: ["alpha", "beta"] };
    o.checks = o.checks.map((c) => (c.goalIds.length ? c : { ...c, unused: true }));
    return o;
  };

  it("puts a goal under every milestone that requires it, and says what is part of nothing", () => {
    const o = twoMilestones();
    o.goals.push({ goal: { ...o.goals[2].goal, id: "loose", title: "Loose ends" }, status: "not_started", checks: [], progress: { met: 0, total: 0 }, parents: [], requires: [], unused: true });
    render(<Harness start={o} />);
    const rows = Array.from(document.querySelectorAll(".hub-goal-row")).map((r) => r.querySelector(".hub-row-title")?.textContent);
    expect(rows.filter((t) => t === "Movement feels right")).toHaveLength(2);
    expect(screen.getByText("Other goals")).toBeTruthy();
    expect(screen.getByText("Not part of any milestone")).toBeTruthy();
    // Every playtest is listed too, and one in no goal says so.
    expect(screen.getByRole("region", { name: "Playtests" }).querySelectorAll(".hub-unused")).toHaveLength(1);
    // The cursor walks rows, so the second copy is reachable.
    for (let i = 0; i < 2; i++) fireEvent.keyDown(document.body, { key: "j" });
    expect(document.querySelectorAll(".hub-goal-row")[2].getAttribute("aria-current")).toBe("true");
    expect(document.querySelectorAll('.hub-goal-row[aria-current="true"]')).toHaveLength(1);
  });

  it("lists every parent under the goal's header", () => {
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={twoMilestones()} />);
    const partOf = screen.getByRole("group", { name: "Part of" });
    expect(within(partOf).getByText("Alpha").closest("a")?.getAttribute("href")).toBe("#/playtests/goals/alpha");
    expect(within(partOf).getByText("Beta")).toBeTruthy();
  });

  it("lists a milestone's required goals in order, and reorders, re-flags, removes and adds them", async () => {
    for (const f of [m.hub.orderRequires, m.hub.addRequire, m.hub.removeRequire]) f.mockResolvedValue({ goal: {} });
    window.location.hash = "#/playtests/goals/alpha";
    render(<Harness start={hubFixture()} />);
    const section = screen.getByRole("region", { name: "Required goals" });
    expect(Array.from(section.querySelectorAll(".hub-row-title")).map((t) => t.textContent)).toEqual(["Movement feels right", "Tutorial completes"]);
    expect((within(section).getByRole("button", { name: "Move Movement feels right up" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(section).getByRole("button", { name: "Move Movement feels right down" }));
    await waitFor(() => expect(m.hub.orderRequires).toHaveBeenCalledWith("alpha", ["tutorial", "movement"]));
    expect(Array.from(section.querySelectorAll(".hub-row-title")).map((t) => t.textContent)).toEqual(["Tutorial completes", "Movement feels right"]);
    fireEvent.click(within(section).getAllByRole("button", { name: "Required" })[0]);
    await waitFor(() => expect(m.hub.addRequire).toHaveBeenCalledWith("alpha", "tutorial", false));
    fireEvent.click(within(section).getByRole("button", { name: "Remove Tutorial completes from this goal" }));
    await waitFor(() => expect(m.hub.removeRequire).toHaveBeenCalledWith("alpha", "tutorial"));
  });

  it("adds an existing goal from the picker, offering none that would make a loop", async () => {
    m.hub.addRequire.mockResolvedValue({ goal: {} });
    window.location.hash = "#/playtests/goals/tutorial";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add goal/ }));
    const picker = screen.getByRole("dialog", { name: "Add goal to Tutorial completes" });
    const options = within(picker).getAllByRole("option").map((o) => o.querySelector(".hub-row-title")?.textContent);
    expect(options).toEqual(["Movement feels right"]);
    fireEvent.click(within(picker).getByRole("option", { name: /Movement/ }));
    await waitFor(() => expect(m.hub.addRequire).toHaveBeenCalledWith("tutorial", "movement"));
  });

  it("keeps a goal's checks in its own order, with up and down", async () => {
    m.hub.orderChecks.mockResolvedValue({ goal: {} });
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    const names = () => Array.from(document.querySelectorAll(".hub-check-row .hub-row-title")).map((t) => t.textContent);
    expect(names()).toEqual(["Jump", "Swim"]);
    fireEvent.click(screen.getByRole("button", { name: "Move Swim up" }));
    expect(names()).toEqual(["Swim", "Jump"]);
    await waitFor(() => expect(m.hub.orderChecks).toHaveBeenCalledWith("movement", ["script:/Game/Tests/Swim", "script:/Game/Tests/Jump"]));
  });
});

describe("a project with playtests and no goals", () => {
  it("is useful at once: every playtest with its health, Run all, Run failing and what just broke", async () => {
    const o = hubFixture();
    o.goals = [];
    o.checks = o.checks.map((c) => ({ ...c, goalIds: [], unused: true }));
    render(<Harness start={o} />);
    const list = screen.getByRole("region", { name: "Playtests" });
    expect(Array.from(list.querySelectorAll(".hub-row-title")).map((t) => t.textContent)).toEqual(["Jump", "Menu", "Swim"]);
    expect(within(list).getByText(/group them into a goal/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Just broke" })).getByText("Jump")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Run all/ }));
    await waitFor(() => expect(m.hub.plan).toHaveBeenCalledWith({ scope: { kind: "all" } }));
    fireEvent.click(screen.getByRole("button", { name: /^Run failing/ }));
    await waitFor(() => expect(m.hub.plan).toHaveBeenLastCalledWith({ scope: { kind: "failing" } }));
  });
});

describe("now running", () => {
  it("is a strip on the Overview: the run on the editor, how far its batch is, the runs waiting, and Stop", async () => {
    const o = hubFixture();
    const item = (name: string, state: "running" | "queued" | "passed") => ({ check: { kind: "script" as const, target: `/Game/Tests/${name}` }, name, state });
    const plan = (id: string, title: string, items: ReturnType<typeof item>[]) => ({ id, title, scope: { kind: "all" as const }, options: { attended: true, stopOnFailure: false, replay: false }, state: "running" as const, items, trigger: "person" as const, createdAt: "2026-11-22T10:00:00Z" });
    o.queue = { ...o.queue, current: plan("p1", "Run all playtests", [item("Jump", "passed"), item("Swim", "running")]), queued: [plan("p2", "Run Tutorial completes", [item("Menu", "queued")])] };
    m.hub.cancelPlan.mockResolvedValue({ plan: {} });
    render(<Harness start={o} />);
    const strip = screen.getByRole("region", { name: "Now running" });
    // The playing item names the line, and the batch's items are listed under it.
    expect(strip.querySelector(".hub-plan-toggle")?.textContent).toBe("Swim");
    expect(within(strip).getByRole("meter", { name: "1 of 2 done" })).toBeTruthy();
    expect(within(strip).getByText("Run Tutorial completes")).toBeTruthy();
    fireEvent.click(within(strip).getByRole("button", { name: "Stop Run Tutorial completes" }));
    await waitFor(() => expect(m.hub.cancelPlan).toHaveBeenCalledWith("p2"));
  });

  it("links to the Queue screen", async () => {
    render(<Harness start={hubFixture()} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Now running" })).getByText("Open queue"));
    await waitFor(() => expect(heading()).toBe("Queue"));
  });
});

describe("a person's Run", () => {
  const runAll = () => fireEvent.click(screen.getByRole("button", { name: "Run all" }));
  const toast = () => screen.getByRole("status");

  it("on an idle or paused queue starts at once and says so", async () => {
    m.hub.plan.mockResolvedValue({ plan: { id: "p1", title: "Run all playtests", items: [{}, {}, {}] }, placement: { state: "started", position: 0, ahead: 0, resumed: true } });
    const o = hubFixture();
    o.queue = { ...o.queue, paused: true, pausedBy: "release" };
    render(<Harness start={o} />);
    runAll();
    await waitFor(() => expect(toast().textContent).toContain("Running every playtest"));
    expect(within(toast()).queryByRole("button", { name: "Run next" })).toBeNull();
  });

  it("behind other runs queues, saying how many are ahead, with Run next and Open queue", async () => {
    m.hub.plan.mockResolvedValue({ plan: { id: "p9", title: "Run all playtests", items: [{}] }, placement: { state: "queued", position: 2, ahead: 2 } });
    m.hub.movePlan.mockResolvedValue(hubFixture().queue);
    render(<Harness start={hubFixture()} />);
    runAll();
    await waitFor(() => expect(toast().textContent).toContain("Queued every playtest, 2 runs ahead"));
    fireEvent.click(within(toast()).getByRole("button", { name: "Run next" }));
    await waitFor(() => expect(m.hub.movePlan).toHaveBeenCalledWith("p9", 0));
    runAll();
    await waitFor(() => within(toast()).getByRole("button", { name: "Open queue" }));
    fireEvent.click(within(toast()).getByRole("button", { name: "Open queue" }));
    await waitFor(() => expect(heading()).toBe("Queue"));
  });

  it("on a busy editor names what holds it", async () => {
    m.hub.runCheck.mockResolvedValue({ plan: { id: "p2", title: "Run Jump", items: [{}] }, placement: { state: "waiting", position: 1, ahead: 0, reason: "Claude Code holds the editor: refactoring" } });
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run Jump" }));
    await waitFor(() => expect(toast().textContent).toMatch(/^Jump is next\. Claude Code holds the editor: refactoring\./));
    expect(toast().classList.contains("bad")).toBe(true);
  });
});

describe("the queue", () => {
  const item = (name: string) => ({ check: { kind: "script" as const, target: `/Game/Tests/${name}` }, name, state: "queued" as const });
  const plan = (id: string, title: string, trigger: "person" | "schedule" | "agent" = "person") => ({ id, title, scope: { kind: "all" as const }, options: { attended: true, stopOnFailure: false, replay: false }, state: "queued" as const, items: [item("Jump")], trigger, createdAt: "2026-11-22T10:00:00Z" });
  const schedule = { id: "s1", title: "Nightly", scope: { kind: "all" as const }, options: { attended: false, stopOnFailure: false, replay: false }, at: "02:00", days: [0, 1, 2, 3, 4, 5, 6], enabled: true, waiting: "Claude Code holds the editor: refactoring", nextRunAt: "2026-11-25T09:00:00Z" };

  it("reorders queued runs: Run next and the arrows move them", async () => {
    const o = hubFixture();
    o.queue = { ...o.queue, queued: [plan("a", "Run A"), plan("b", "Run B", "schedule"), plan("c", "Run C")] };
    m.hub.movePlan.mockImplementation(async (_id: string, _to: number) => o.queue);
    window.location.hash = "#/playtests/queue";
    render(<Harness start={o} />);
    expect(screen.getByText("Scheduled")).toBeTruthy();
    fireEvent.click(within(screen.getByText("Run C").closest("li")!).getByRole("button", { name: "Run next" }));
    await waitFor(() => expect(m.hub.movePlan).toHaveBeenCalledWith("c", 0));
    fireEvent.click(screen.getByRole("button", { name: "Move Run B down" }));
    await waitFor(() => expect(m.hub.movePlan).toHaveBeenCalledWith("b", 2));
  });

  it("lists schedules with why a due one waits, and creates, toggles and deletes them", async () => {
    const o = hubFixture();
    o.queue = { ...o.queue, schedules: [schedule] };
    m.hub.createSchedule.mockResolvedValue({ schedule });
    m.hub.updateSchedule.mockResolvedValue({ schedule });
    m.hub.deleteSchedule.mockResolvedValue(undefined);
    window.location.hash = "#/playtests/queue";
    render(<Harness start={o} />);
    expect(screen.getByText("Due, waiting: Claude Code holds the editor: refactoring")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Nightly on" }));
    await waitFor(() => expect(m.hub.updateSchedule).toHaveBeenCalledWith("s1", { enabled: false }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Nightly" }));
    await waitFor(() => expect(m.hub.deleteSchedule).toHaveBeenCalledWith("s1"));
    fireEvent.click(screen.getByRole("button", { name: /New schedule/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => expect(m.hub.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ title: "Nightly", at: "02:00", options: expect.objectContaining({ attended: false }) })));
  });

  it("says schedules need a newer ue-mcp when the daemon has none", () => {
    window.location.hash = "#/playtests/queue";
    const o = hubFixture();
    // A daemon older than ue-mcp 1.4.16-beta.3 answers a queue without schedules.
    const { schedules: _, ...older } = o.queue;
    o.queue = older as typeof o.queue;
    render(<Harness start={o} />);
    expect(screen.getByText("Update ue-mcp to use schedules.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New schedule/ })).toBeNull();
  });
});

describe("the library", () => {
  it("selects rows and runs them as one plan", async () => {
    window.location.hash = "#/playtests/checks";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByLabelText("Select Jump"));
    key("j");
    key("x");
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Run selected/ }));
    await waitFor(() => expect(m.hub.plan).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "checks", checks: [hubFixture().checks[0].check, hubFixture().checks[2].check] } })));
  });

  it("filters by health", () => {
    window.location.hash = "#/playtests/checks";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Never run/ }));
    expect(document.querySelectorAll(".hub-check-row").length).toBe(1);
    expect(screen.getByText("Menu")).toBeTruthy();
  });
});

describe("deleting playtests", () => {
  it("confirms by asset path from a playtest, deletes it and returns to Playtests", async () => {
    m.del.mockResolvedValue({ script: "/Game/Tests/Menu" });
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[2], runs: [], more: false, script: null });
    window.location.hash = "#/playtests/checks/" + encodeURIComponent("script:/Game/Tests/Menu");
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Delete/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete this playtest?" });
    expect(within(dialog).getByText("/Game/Tests/Menu")).toBeTruthy();
    expect(m.del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(heading()).toBe("Playtests"));
    expect(m.del).toHaveBeenCalledWith("/Game/Tests/Menu");
  });

  it("cancels without deleting", () => {
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[2], runs: [], more: false, script: null });
    window.location.hash = "#/playtests/checks/" + encodeURIComponent("script:/Game/Tests/Menu");
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.del).not.toHaveBeenCalled();
  });

  it("deletes the selection in one pass and names the ones that failed", async () => {
    m.del.mockImplementation(async (p: string) => {
      if (p === "/Game/Tests/Swim") throw new Error("Asset is referenced");
      return { script: p };
    });
    window.location.hash = "#/playtests/checks";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByLabelText("Select all 3"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete 3 playtests?" });
    for (const p of ["Jump", "Swim", "Menu"]) expect(within(dialog).getByText("/Game/Tests/" + p)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "1 of 3 could not be deleted" });
    expect(m.del.mock.calls.map((c) => c[0])).toEqual(["/Game/Tests/Jump", "/Game/Tests/Swim", "/Game/Tests/Menu"]);
    expect(within(screen.getByRole("dialog")).getByText("Swim")).toBeTruthy();
    expect(screen.getByText("Asset is referenced")).toBeTruthy();
  });
});

describe("deleting goals and milestones", () => {
  it("is hidden when the daemon does not offer it", () => {
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    window.location.hash = "#/playtests/goals";
    cleanup();
    render(<Harness start={hubFixture()} />);
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("confirms from the goal page, saying its playtests stay and naming the goals that required it, then goes back the way the user came", async () => {
    m.hub.deleteGoal.mockResolvedValue(undefined);
    window.location.hash = "#/playtests/goals/alpha";
    render(<Harness start={hubFixture()} canDeleteGoals />);
    fireEvent.click(within(screen.getByRole("region", { name: "Required goals" })).getByText("Movement feels right"));
    expect(heading()).toBe("Movement feels right");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete the goal "Movement feels right"?' });
    expect(within(dialog).getByText("Its playtests stay in the library and keep their past runs.")).toBeTruthy();
    expect(within(within(dialog).getByRole("list", { name: "These will no longer require it:" })).getByText("Alpha")).toBeTruthy();
    expect(m.hub.deleteGoal).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete goal" }));
    await waitFor(() => expect(heading()).toBe("Alpha"));
    expect(m.hub.deleteGoal).toHaveBeenCalledWith("movement");
    expect(screen.getByRole("status").textContent).toContain("Deleted Movement feels right");
  });

  it("goes to the Milestones list after deleting a milestone opened fresh", async () => {
    m.hub.deleteGoal.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "#/playtests/goals/alpha");
    render(<Harness start={hubFixture()} canDeleteGoals />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete the milestone "Alpha"?' });
    expect(within(dialog).getByText("The goals it requires stay. Its playtests stay in the library and keep their past runs.")).toBeTruthy();
    expect(within(dialog).queryByRole("list")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete milestone" }));
    await waitFor(() => expect(heading()).toBe("Milestones"));
    expect(m.hub.deleteGoal).toHaveBeenCalledWith("alpha");
  });

  it("deletes from the Goals list without leaving it, and shows a refusal in the dialog", async () => {
    m.hub.deleteGoal.mockRejectedValueOnce(new Error('"Tutorial completes" can\'t be deleted while a run made for it is queued or running: "Run Tutorial completes". Cancel that run or let it finish, then try again.'));
    m.hub.deleteGoal.mockResolvedValueOnce(undefined);
    window.location.hash = "#/playtests/goals";
    render(<Harness start={hubFixture()} canDeleteGoals />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Tutorial completes" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete the goal "Tutorial completes"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete goal" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Cancel that run");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete goal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.hub.deleteGoal).toHaveBeenCalledTimes(2);
    expect(heading()).toBe("Goals");
  });

  it("offers Delete on each milestone in the Milestones list", () => {
    window.location.hash = "#/playtests/milestones";
    render(<Harness start={hubFixture()} canDeleteGoals />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    expect(screen.getByRole("dialog", { name: 'Delete the milestone "Alpha"?' })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.hub.deleteGoal).not.toHaveBeenCalled();
  });
});

describe("tracker links", () => {
  const issue = "https://git.example.com/ember/hollow/issues/42";
  const withLinks = (): HubOverview => {
    const o = hubFixture();
    const g = o.goals[1];
    g.goal.links = [{ url: issue, title: "Movement", rel: "counterpart" }];
    // A playtest's links are its own, on its state wherever it is listed.
    g.checks = [{ ...g.checks[0], links: [{ url: "jira://HOL-7" }] }, g.checks[1]];
    return o;
  };

  it("shows a goal's links and its checks' links as chips that open outside Studio", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={withLinks()} />);
    const links = screen.getByRole("group", { name: "Links" });
    const chip = within(links).getByText("Movement").closest("a")!;
    expect(chip.getAttribute("href")).toBe(issue);
    expect(within(chip).getByText("git.example.com")).toBeTruthy();
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(issue, "_blank", "noopener");
    expect(screen.getByText("HOL-7")).toBeTruthy();
    open.mockRestore();
  });

  it("adds a link inline, refuses one that cannot open safely, and removes one", async () => {
    m.hub.updateGoal.mockResolvedValue({ goal: {} });
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={withLinks()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add link/ }));
    fireEvent.change(screen.getByLabelText("Link URL"), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toContain("cannot be opened safely");
    expect(m.hub.updateGoal).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Link URL"), { target: { value: "trello.com/c/abc" } });
    fireEvent.change(screen.getByLabelText("Link title"), { target: { value: "Card" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(m.hub.updateGoal).toHaveBeenCalledWith("movement", { links: [{ url: issue, title: "Movement", rel: "counterpart" }, { url: "https://trello.com/c/abc", title: "Card" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Remove link Movement" }));
    await waitFor(() => expect(m.hub.updateGoal).toHaveBeenLastCalledWith("movement", { links: [{ url: "https://trello.com/c/abc", title: "Card" }] }));
  });
});

describe("going back", () => {
  const crumbs = () => Array.from(screen.getByRole("navigation", { name: "Where you came from" }).querySelectorAll(".hub-crumb")).map((c) => c.textContent?.replace(/^\//, ""));

  it("follows the way taken, not the hub's map: from a milestone into a playtest, back returns to each screen before it", async () => {
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[0], runs: [], more: false, script: null });
    window.location.hash = "#/playtests/goals/alpha";
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Alpha");
    // A milestone's run covers its required goals' playtests and says how many.
    expect(screen.getByRole("button", { name: "Run all (2)" })).toBeTruthy();
    const required = screen.getByRole("region", { name: "Required goals" });
    fireEvent.click(within(required).getByText("Movement feels right"));
    expect(heading()).toBe("Movement feels right");
    fireEvent.click(screen.getAllByText("Jump").find((e) => e.closest("a[href]"))!);
    expect(heading()).toBe("Jump");
    expect(crumbs()).toEqual(["Alpha", "Movement feels right", "Jump"]);
    // The map would send Back to the Playtests list; the way taken sends it to the goal, then the milestone.
    fireEvent.click(screen.getByRole("link", { name: "Back: Movement feels right" }));
    await waitFor(() => expect(heading()).toBe("Movement feels right"));
    expect(crumbs()).toEqual(["Alpha", "Movement feels right"]);
    fireEvent.click(screen.getByRole("link", { name: "Back: Alpha" }));
    await waitFor(() => expect(heading()).toBe("Alpha"));
  });

  it("goes straight back to an earlier screen from its crumb, and Forward brings the trail back", async () => {
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[0], runs: [], more: false, script: null });
    window.location.hash = "#/playtests/goals/alpha";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Required goals" })).getByText("Movement feels right"));
    fireEvent.click(screen.getAllByText("Jump").find((e) => e.closest("a[href]"))!);
    const nav = screen.getByRole("navigation", { name: "Where you came from" });
    fireEvent.click(within(nav).getByRole("link", { name: "Alpha" }));
    await waitFor(() => expect(heading()).toBe("Alpha"));
    act(() => window.history.go(2));
    await waitFor(() => expect(heading()).toBe("Jump"));
    expect(crumbs()).toEqual(["Alpha", "Movement feels right", "Jump"]);
  });

  it("falls back to the screen's parent in the map for a deep link opened fresh", () => {
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[0], runs: [], more: false, script: null });
    window.history.replaceState(null, "", "#/playtests/checks/" + encodeURIComponent("script:/Game/Tests/Jump"));
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Jump");
    expect(screen.queryByRole("navigation", { name: "Where you came from" })).toBeNull();
    expect(screen.getByText("Playtests", { selector: ".hub-back" }).getAttribute("href")).toBe("#/playtests/checks");
  });

  it("returns to the tab a link was followed from", async () => {
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[0], runs: [], more: false, script: null });
    window.history.replaceState(null, "", "#/chat/s1");
    window.location.hash = "#/playtests/checks/" + encodeURIComponent("script:/Game/Tests/Jump");
    window.history.replaceState({ hubTrail: { routes: [{ screen: "check", checkId: "script:/Game/Tests/Jump" }], from: "Chat" } }, "");
    render(<Harness start={hubFixture()} />);
    expect(crumbs()).toEqual(["Chat", "Jump"]);
    fireEvent.click(screen.getByRole("link", { name: "Back: Chat" }));
    await waitFor(() => expect(window.location.hash).toBe("#/chat/s1"));
  });
});

describe("a playtest's script", () => {
  it("opens in Unreal from the playtest's screen", async () => {
    m.hub.check.mockResolvedValue({ state: hubFixture().checks[0], runs: [], more: false, script: null });
    window.location.hash = "#/playtests/checks/" + encodeURIComponent("script:/Game/Tests/Jump");
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Unreal" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledWith("/Game/Tests/Jump.Jump"));
  });
});

describe("Fix failing playtests with an agent", () => {
  it("shows no Fix button while the setting is off, and leads to the setting instead", async () => {
    m.agentSettings.mockResolvedValue({ agentFixes: false });
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    const link = await screen.findByRole("link", { name: "Turn it on in Settings" });
    expect(link.getAttribute("href")).toBe("#/settings/approvals");
    expect(screen.getByText(/Fixing with an agent is off/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fix failing with an agent/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Fix with an agent: / })).toBeNull();
    // Its key does nothing either.
    key("a");
    expect(m.hub.fix).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/settings/approvals");
  });

  it("lists the a shortcut only while it is on", async () => {
    window.location.hash = "#/playtests/goals/movement";
    const { unmount } = render(<Harness start={hubFixture()} />);
    key("?");
    expect(await screen.findByText("Fix the goal's failing playtests with an agent")).toBeTruthy();
    unmount();
    m.agentSettings.mockResolvedValue({ agentFixes: false });
    render(<Harness start={hubFixture()} />);
    key("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await waitFor(() => expect(m.agentSettings).toHaveBeenCalled());
    expect(screen.getByText("New goal")).toBeTruthy();
    expect(screen.queryByText("Fix the goal's failing playtests with an agent")).toBeNull();
  });

  it("offers Fix while it is on", async () => {
    m.hub.fix.mockResolvedValue({ queued: 1, plan: null });
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    expect(await screen.findByRole("button", { name: /Fix failing with an agent/ })).toBeTruthy();
    expect(screen.queryByText(/Fixing with an agent is off/)).toBeNull();
    key("a");
    await waitFor(() => expect(m.hub.fix).toHaveBeenCalledWith({ goalId: "movement" }));
  });
});
