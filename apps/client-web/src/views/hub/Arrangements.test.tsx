// @vitest-environment jsdom
/**
 * A project's arrangements against stubbed daemon answers: the rail's entry
 * opens the list, a row opens its arrangement in its own history entry, New,
 * Rename, Level, Duplicate and Delete go to their routes, the last one cannot
 * be deleted, and the Arrangement's switcher opens another arrangement whose
 * edits and runs name it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ArrangementSummary, HubOverview, SetAnswer } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  hub: { overview: vi.fn(), cancelPlan: vi.fn(), resultsUrl: (id: string) => `/r/${id}` },
  set: {
    read: vi.fn(), edit: vi.fn(), clips: vi.fn(), run: vi.fn(), runDetail: vi.fn(), verdict: vi.fn(),
    arrangements: vi.fn(), createArrangement: vi.fn(), updateArrangement: vi.fn(), duplicateArrangement: vi.fn(), deleteArrangement: vi.fn(),
  },
}));
vi.mock("../../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly body?: unknown) {
      super(message);
    }
  }
  return { ApiError, api: { hub: m.hub, set: m.set, clips: {}, settings: () => new Promise(() => {}), agentSettings: () => new Promise(() => {}) } };
});
import { HubView } from "./Hub";
import type { HubData } from "./state";
import { hubFixture } from "./test-data";

const summary = (id: string, title: string, extra: Partial<ArrangementSummary> = {}): ArrangementSummary => ({ id, title, order: 0, level: null, tracks: 1, scenes: 0, status: "not_started", lastRun: null, ...extra });
const MAIN = summary("main", "Main", { tracks: 2, scenes: 1 });
const BOSS = summary("boss-k3f9", "Boss rush", { order: 1, level: "/Game/Maps/Arena", lastRun: { runId: "r1", outcome: "passed", at: new Date().toISOString() } });
const setOf = (id: string, title: string): SetAnswer => ({
  text: "",
  findings: [],
  arrangement: { id, title, order: 0, level: null },
  tracks: [{ id: `${id}-t`, title: `${title} track`, order: 0, player: 0, mute: false, solo: false, status: "not_started", arrangement: { rate: 60, instances: [] }, layout: [] }],
  scenes: [],
});

function Harness({ features = ["hub", "hub.arrangement", "hub.arrangements"] }: { features?: string[] }) {
  const [overview] = useState<HubOverview | null>(hubFixture());
  const data: HubData = { overview, error: null, version: 0, reload: () => {}, patch: () => {} };
  return <HubView data={data} narrow={false} onOpenChat={() => {}} events={[]} health={{ features }} />;
}

beforeEach(() => {
  for (const f of [...Object.values(m.hub), ...Object.values(m.set)] as unknown[]) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  m.set.arrangements.mockResolvedValue({ arrangements: [MAIN, BOSS], default: "main" });
  m.set.read.mockImplementation(async (id?: string | null) => (id === BOSS.id ? setOf(BOSS.id, BOSS.title) : setOf("main", "Main")));
  m.set.edit.mockImplementation(async (_lines: string[], id?: string | null) => (id === BOSS.id ? setOf(BOSS.id, BOSS.title) : setOf("main", "Main")));
  m.set.clips.mockResolvedValue({ clips: [] });
  m.set.run.mockResolvedValue({ plan: { id: "p1", title: "Run Boss rush", items: [] }, placement: { state: "started", position: 0, ahead: 0 } });
  m.set.createArrangement.mockResolvedValue({ arrangement: { id: "night-a1b2", title: "Night", order: 2, level: "/Game/Maps/Night" } });
  m.set.updateArrangement.mockResolvedValue({ arrangement: { ...BOSS } });
  m.set.duplicateArrangement.mockResolvedValue({ arrangement: { id: "boss-copy", title: "Boss rush copy", order: 2, level: null } });
  m.set.deleteArrangement.mockResolvedValue(undefined);
  window.location.hash = "#/playtests/arrangements";
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const row = async (title: string) => (await screen.findByText(title, { selector: ".hub-row-title" })).closest("li")!;

describe("the list of arrangements", () => {
  it("is the rail's entry where the daemon has several, and a row opens its arrangement in its own history entry", async () => {
    window.location.hash = "#/playtests";
    render(<Harness />);
    fireEvent.click(await screen.findByRole("link", { name: /^Arrangements/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/playtests/arrangements"));
    const boss = await row("Boss rush");
    expect(within(boss).getByText("Opens Arena")).toBeTruthy();
    expect(within(boss).getByText(/^Last run passed/)).toBeTruthy();
    fireEvent.click(within(boss).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe(`#/playtests/arrangement/${BOSS.id}`));
    await waitFor(() => expect(m.set.read).toHaveBeenCalledWith(BOSS.id));
    // The list and the arrangement both light the rail's entry.
    expect([...document.querySelectorAll("nav.hub-rail .hub-rail-item.active")].map((a) => a.textContent)).toEqual(["Arrangements"]);
  });

  it("keeps the one Arrangement in the rail for a daemon without arrangements", async () => {
    window.location.hash = "#/playtests";
    render(<Harness features={["hub", "hub.arrangement"]} />);
    expect(await screen.findByRole("link", { name: /^Arrangement$/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Arrangements/ })).toBeNull();
  });

  it("creates one with a level and opens it", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /New arrangement/ }));
    const dialog = await screen.findByRole("dialog", { name: "New arrangement" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Night" } });
    fireEvent.change(within(dialog).getByLabelText("Level"), { target: { value: "/Game/Maps/Night" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(m.set.createArrangement).toHaveBeenCalledWith("Night", "/Game/Maps/Night"));
    await waitFor(() => expect(window.location.hash).toBe("#/playtests/arrangement/night-a1b2"));
  });

  it("renames, sets and clears the level, duplicates and deletes", async () => {
    render(<Harness />);
    fireEvent.click(within(await row("Boss rush")).getByRole("button", { name: "Rename" }));
    let dialog = await screen.findByRole("dialog", { name: 'Rename "Boss rush"' });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Boss rush 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.set.updateArrangement).toHaveBeenCalledWith(BOSS.id, { title: "Boss rush 2" }));

    fireEvent.click(within(await row("Boss rush")).getByRole("button", { name: "Level" }));
    dialog = await screen.findByRole("dialog", { name: 'Level for "Boss rush"' });
    fireEvent.change(within(dialog).getByLabelText("Level"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.set.updateArrangement).toHaveBeenCalledWith(BOSS.id, { level: null }));

    fireEvent.click(within(await row("Boss rush")).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(m.set.duplicateArrangement).toHaveBeenCalledWith(BOSS.id));
    expect(await screen.findByText("Duplicated as Boss rush copy")).toBeTruthy();

    fireEvent.click(within(await row("Boss rush")).getByRole("button", { name: "Delete Boss rush" }));
    dialog = await screen.findByRole("dialog", { name: 'Delete the arrangement "Boss rush"?' });
    expect(within(dialog).getByText(/Clips stay in Clips/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(m.set.deleteArrangement).toHaveBeenCalledWith(BOSS.id));
  });

  it("does not offer to delete the only arrangement, and says what to do instead", async () => {
    m.set.arrangements.mockResolvedValue({ arrangements: [MAIN], default: "main" });
    render(<Harness />);
    const del = within(await row("Main")).getByRole("button", { name: "Delete Main" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toContain("Create another");
  });
});

describe("the switcher", () => {
  it("opens another arrangement from the transport, and its edits and runs name it", async () => {
    window.location.hash = "#/playtests/arrangement";
    render(<Harness />);
    const switcher = await screen.findByRole("button", { name: "Arrangement shown: Main" });
    fireEvent.click(switcher);
    const list = await screen.findByRole("listbox", { name: "Arrangement shown" });
    fireEvent.click(within(list).getByRole("option", { name: /Boss rush/ }));
    await waitFor(() => expect(window.location.hash).toBe(`#/playtests/arrangement/${BOSS.id}`));
    expect(await screen.findByRole("button", { name: "Arrangement shown: Boss rush" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Play" }));
    await waitFor(() => expect(m.set.run).toHaveBeenCalledWith({ kind: "arrangement", arrangementId: BOSS.id }));
    fireEvent.keyDown(screen.getByRole("group", { name: "Arrangement" }), { key: "t", ctrlKey: true });
    await waitFor(() => expect(m.set.edit).toHaveBeenCalledWith([expect.stringMatching(/^track add/)], BOSS.id));
    // All arrangements goes to the list.
    fireEvent.click(screen.getByRole("button", { name: "Arrangement shown: Boss rush" }));
    fireEvent.click(await screen.findByRole("button", { name: "All arrangements" }));
    await waitFor(() => expect(window.location.hash).toBe("#/playtests/arrangements"));
  });
});
