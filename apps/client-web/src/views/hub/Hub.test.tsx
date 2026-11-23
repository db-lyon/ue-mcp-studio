// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { HubOverview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  hub: {
    overview: vi.fn(), verdict: vi.fn(), plan: vi.fn(), runCheck: vi.fn(), createGoal: vi.fn(), updateGoal: vi.fn(), check: vi.fn(), run: vi.fn(),
    runs: vi.fn(), addChecks: vi.fn(), removeCheck: vi.fn(), assign: vi.fn(), assignFailing: vi.fn(), writePlaytests: vi.fn(), resultsUrl: (id: string) => `/r/${id}`,
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
    window.location.hash = "#/playtests/inbox";
    render(<Harness start={hubFixture()} />);
    expect(heading()).toContain("Inbox");
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
    expect(within(bar).getByText("Inbox").closest("a")?.querySelector(".tab-count")?.textContent).toBe("3");
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
    const box = screen.getByLabelText("Filter checks");
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

describe("the inbox", () => {
  it("passes the selected verdict with p, and the row leaves at once", async () => {
    window.location.hash = "#/playtests/inbox";
    render(<Harness start={hubFixture()} />);
    expect(screen.getByText("Walk to the door and see it open")).toBeTruthy();
    key("p");
    expect(screen.queryByText("Walk to the door and see it open")).toBeNull();
    await waitFor(() => expect(m.hub.verdict).toHaveBeenCalledWith("run-a", 1, "pass", undefined));
    // The next item is selected: s skips it.
    key("s");
    await waitFor(() => expect(m.hub.verdict).toHaveBeenCalledWith("run-b", 0, "skip", undefined));
  });

  it("asks for a note before a fail, and sends it", async () => {
    window.location.hash = "#/playtests/inbox";
    render(<Harness start={hubFixture()} />);
    key("f");
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "The door stays shut" } });
    fireEvent.click(submit);
    await waitFor(() => expect(m.hub.verdict).toHaveBeenCalledWith("run-a", 1, "fail", "The door stays shut"));
  });

  it("brings a verdict back and says why when the daemon refuses it", async () => {
    m.hub.verdict.mockRejectedValue(new Error("The run has ended"));
    window.location.hash = "#/playtests/inbox";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Pass" })[0]);
    expect(await screen.findByText(/The verdict was not recorded: The run has ended/)).toBeTruthy();
    expect(screen.getByText("Walk to the door and see it open")).toBeTruthy();
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
    await waitFor(() => expect(m.hub.createGoal).toHaveBeenCalledWith(expect.objectContaining({ title: "Four players join", acceptance: { stableRuns: 3, staleAfterDays: 14, signOff: false } })));
    await waitFor(() => expect(window.location.hash).toBe("#/playtests/goals/four-players-join"));
  });

  it("edits a goal with its values filled in", async () => {
    m.hub.updateGoal.mockResolvedValue({ goal: {} });
    window.location.hash = "#/playtests/goals/movement";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit goal" });
    expect((within(dialog).getByLabelText("Owner") as HTMLInputElement).value).toBe("dana");
    expect((within(dialog).getByLabelText("Milestone") as HTMLSelectElement).value).toBe("alpha");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.hub.updateGoal).toHaveBeenCalledWith("movement", expect.objectContaining({ owner: "dana", parent: "alpha", priority: "p1" })));
  });
});

describe("a project with scripts and no goals", () => {
  it("lists the scripts and offers to make goals from them in one click", async () => {
    const o = hubFixture();
    o.goals = [];
    o.checks = o.checks.map((c) => ({ ...c, goalIds: [] }));
    m.hub.createGoal.mockResolvedValue({ goal: {} });
    render(<Harness start={o} />);
    expect(screen.getByText("No goals yet")).toBeTruthy();
    expect(screen.getByText("3 test scripts in this project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create 2 goals, one per map" }));
    await waitFor(() => expect(m.hub.createGoal).toHaveBeenCalledTimes(2));
    expect(m.hub.createGoal).toHaveBeenCalledWith({ title: "Arena plays through", checks: [o.checks[0].check, o.checks[1].check] });
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
    g.goal.checks = [{ ...g.goal.checks[0], links: [{ url: "jira://HOL-7" }] }, g.goal.checks[1]];
    g.checks = [{ ...g.checks[0], check: g.goal.checks[0] }, g.checks[1]];
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
