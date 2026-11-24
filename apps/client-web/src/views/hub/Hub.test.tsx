// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { HubOverview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  hub: {
    overview: vi.fn(), verdict: vi.fn(), plan: vi.fn(), runCheck: vi.fn(), createGoal: vi.fn(), updateGoal: vi.fn(), check: vi.fn(), run: vi.fn(),
    runs: vi.fn(), addChecks: vi.fn(), removeCheck: vi.fn(), fix: vi.fn(), writePlaytests: vi.fn(), resultsUrl: (id: string) => `/r/${id}`,
    addRequire: vi.fn(), removeRequire: vi.fn(), orderRequires: vi.fn(), orderChecks: vi.fn(), cancelPlan: vi.fn(), pause: vi.fn(),
  },
}));
vi.mock("../../api", () => ({ api: { hub: m.hub, qaCaptureUrl: () => "", settings: () => new Promise(() => {}) } }));
import { HubView } from "./Hub";
import type { HubData } from "./state";
import { hubFixture } from "./test-data";

function Harness({ start, narrow = false, onOpenChat = () => {} }: { start: HubOverview; narrow?: boolean; onOpenChat?: (s: string, r?: string) => void }) {
  const [overview, setOverview] = useState<HubOverview | null>(start);
  const data: HubData = { overview, error: null, version: 0, reload: () => {}, patch: (f) => setOverview((o) => (o ? f(o) : o)) };
  return <HubView data={data} narrow={narrow} onOpenChat={onOpenChat} />;
}

const key = (k: string, o: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(document.body, { key: k, ...o });
const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

beforeEach(() => {
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
    // The Queue screen is gone: its old address is the Overview, where Now running is.
    window.location.hash = "#/playtests/queue";
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Overview");
    act(() => {
      window.location.hash = "#/playtests/goals/movement";
    });
    await waitFor(() => expect(heading()).toBe("Movement feels right"));
    act(() => {
      window.location.hash = "#/playtests/checks";
    });
    await waitFor(() => expect(heading()).toBe("Library"));
  });

  it("moves between screens from the rail as links, each with its own URL", async () => {
    render(<Harness start={hubFixture()} />);
    expect(heading()).toBe("Overview");
    const rail = screen.getByRole("navigation", { name: "Playtests" });
    const library = within(rail).getByText("Library").closest("a")!;
    expect(library.getAttribute("href")).toBe("#/playtests/checks");
    fireEvent.click(library);
    expect(window.location.hash).toBe("#/playtests/checks");
    expect(heading()).toBe("Library");
    fireEvent.click(within(rail).getByText("Tutorial completes"));
    expect(window.location.hash).toBe("#/playtests/goals/tutorial");
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
    expect(within(bar).getByText("Overview").closest("a")?.querySelector(".tab-count")?.textContent).toBe("2");
  });
});

describe("the keyboard", () => {
  it("jumps with g then a letter, and moves and opens with j, k and Enter", () => {
    render(<Harness start={hubFixture()} />);
    key("g");
    key("l");
    expect(heading()).toBe("Library");
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
    expect(heading()).toBe("Library");
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
    fireEvent.change(within(dialog).getByLabelText("Passing runs in a row"), { target: { value: "11" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    expect(within(dialog).getByText("From 1 to 10 runs.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Passing runs in a row"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    await waitFor(() => expect(m.hub.createGoal).toHaveBeenCalledWith(expect.objectContaining({ title: "Four players join", acceptance: { stableRuns: 3, signOff: false } })));
    await waitFor(() => expect(window.location.hash).toBe("#/playtests/goals/four-players-join"));
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
