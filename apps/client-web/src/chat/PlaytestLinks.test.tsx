// @vitest-environment jsdom
/**
 * Asset names on a Playtest card link as they do in chat (db-lyon/ue-mcp-studio#53):
 * step text, the script path under the title, and each arrange and act target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { qaDraftFromScript, type AssetRef, type AssetResolution, type QaRun } from "@ue-mcp-studio/shared";
import { openCard } from "./qa-test-helpers";

const m = vi.hoisted(() => ({
  openAsset: vi.fn(async (path: string) => ({ path, alreadyOpen: false })),
  resolveAssets: vi.fn(),
  reportAssetMiss: vi.fn(async () => undefined),
  qaCaptureUrl: (runId: string, step: number, n: number) => `/v1/ext/studio/qa/runs/${runId}/steps/${step}/captures/${n}`,
  qaResultsUrl: (id: string) => `/v1/ext/studio/qa/runs/${id}/results`,
}));
vi.mock("../api", () => {
  class ApiError extends Error {}
  return { ApiError, api: m };
});
import { AssetLinks, AssetLinksContext, stepParts, stepPlain } from "./asset-links";
import { StepText } from "./AssetLink";
import { QaCard, QaContext, type QaLive } from "./Qa";
import { stepSetup } from "./step-setup";

describe("a step's text, split for linking", () => {
  it("takes a markdown link exactly, a code span and a bare object path as candidates, and asset-like identifiers", () => {
    expect(stepParts("Load [L_WG_Meadow](/Game/Maps/L_WG_Meadow) and press `IA_Jump` near /Game/Props/SM_Crate.SM_Crate, then cross BP_Bridge_Broken.")).toEqual([
      { kind: "text", text: "Load " },
      { kind: "exact", path: "/Game/Maps/L_WG_Meadow.L_WG_Meadow", label: "L_WG_Meadow" },
      { kind: "text", text: " and press " },
      { kind: "asset", token: "IA_Jump", code: true },
      { kind: "text", text: " near " },
      { kind: "asset", token: "/Game/Props/SM_Crate.SM_Crate", code: false },
      { kind: "text", text: ", then cross " },
      { kind: "asset", token: "BP_Bridge_Broken", code: false },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves plain words, code that names no asset, web links and property paths alone", () => {
    expect(stepParts("Walk to the door_frame, run `jump twice`, read [docs](https://example.com) and BP_Door.OpenAngle")).toEqual([
      { kind: "text", text: "Walk to the door_frame, run " },
      { kind: "code", text: "jump twice" },
      { kind: "text", text: ", read [docs](https://example.com) and BP_Door.OpenAngle" },
    ]);
  });

  it("reads as words alone where a link cannot go", () => {
    expect(stepPlain("Open [L_WG_Meadow](/Game/Maps/L_WG_Meadow) and press `IA_Jump`")).toBe("Open L_WG_Meadow and press IA_Jump");
  });
});

describe("a step's arrange and act", () => {
  it("names what each entry does and to what", () => {
    expect(stepSetup({
      arrange: [{ kind: "spawn", class: "/Game/AI/BP_Wolf.BP_Wolf_C" }, { kind: "set", target: "Door", path: "OpenAngle", value: 0 }, { kind: "call", target: "Gate", func: "Lock" }],
      act: [{ place: { at: "Door", offset: [-150, 0, 0] } }, { press: { action: "/Game/Input/IA_Interact.IA_Interact" } }],
    })).toEqual({
      arrange: [{ verb: "spawn", target: "/Game/AI/BP_Wolf.BP_Wolf_C" }, { verb: "set", target: "Door", detail: "OpenAngle = 0" }, { verb: "call", target: "Gate", detail: "Lock" }],
      act: [{ verb: "place at", target: "Door" }, { verb: "press", target: "/Game/Input/IA_Interact.IA_Interact" }],
    });
    expect(stepSetup({})).toEqual({ arrange: [], act: [] });
  });
});

type Results = Record<string, AssetResolution>;
const fromTable = (results: Results) => async (refs: AssetRef[]) => refs.map((r) => results[r.token] ?? { status: "unresolved" as const });

describe("asset links on a Playtest card", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const SCRIPT = "/Game/PIEStudio/Scripts/TS_Playtest_BP_Obstacle_BrokenBridge";
  const draft = (): QaRun => qaDraftFromScript({
    path: SCRIPT,
    name: "TS_Playtest_BP_Obstacle_BrokenBridge",
    map: "/Game/Maps/L_WG_Meadow",
    steps: [
      { instruction: "Load [L_WG_Meadow](/Game/Maps/L_WG_Meadow) and walk to BP_Obstacle_BrokenBridge", judge: "manual" },
      { instruction: "Press `IA_Jump` at the gap, past /Game/Props/SM_Plank.SM_Plank, and BP_Missing_Thing does not matter", judge: "manual",
        arrange: [{ kind: "spawn", class: "/Game/AI/BP_Wolf.BP_Wolf_C" }], act: [{ press: { action: "/Game/Input/IA_Jump.IA_Jump" } }] },
      { instruction: "The bridge holds", judge: "auto", expect: { value: "CharacterMovement.MovementMode", op: "eq", target: 1 } },
    ],
  }, { sessionId: "s1", seenAt: "2026-10-28T10:00:00.000Z" })!;

  const mount = (results: Results) => {
    const resolve = vi.fn(fromTable(results));
    const store = new AssetLinks(resolve, "s1", 10);
    const live: QaLive = { events: [], streaming: true, forms: [] };
    const r = render(
      <QaContext.Provider value={live}>
        <AssetLinksContext.Provider value={store}>
          <QaCard run={draft()} />
        </AssetLinksContext.Provider>
      </QaContext.Provider>,
    );
    openCard(r.container);
    return { resolve };
  };
  const step = (n: number) => document.querySelectorAll<HTMLElement>(".qa-step")[n];

  it("links a markdown link exactly, upgrades names and paths that resolve, and leaves the rest plain", async () => {
    const { resolve } = mount({
      BP_Obstacle_BrokenBridge: { status: "resolved", paths: ["/Game/Obstacles/BP_Obstacle_BrokenBridge.BP_Obstacle_BrokenBridge"] },
      IA_Jump: { status: "resolved", paths: ["/Game/Input/IA_Jump.IA_Jump"] },
      "/Game/Props/SM_Plank.SM_Plank": { status: "resolved", paths: ["/Game/Props/SM_Plank.SM_Plank"] },
    });
    const map = within(step(0)).getByRole("button", { name: "L_WG_Meadow" });
    expect(map.getAttribute("title")).toBe("/Game/Maps/L_WG_Meadow.L_WG_Meadow");
    expect(step(0).querySelector(".qa-instruction")!.textContent).toBe("Load L_WG_Meadow and walk to BP_Obstacle_BrokenBridge");
    await act(() => vi.advanceTimersByTimeAsync(20));
    const asked = resolve.mock.calls.flatMap(([refs]) => refs.map((r: AssetRef) => r.token));
    expect(asked).toEqual(expect.arrayContaining(["BP_Obstacle_BrokenBridge", "IA_Jump", "/Game/Props/SM_Plank.SM_Plank", "BP_Missing_Thing"]));
    // The markdown link is exact: never looked up.
    expect(asked).not.toContain("L_WG_Meadow");
    expect(within(step(0)).getByRole("button", { name: "BP_Obstacle_BrokenBridge" }).getAttribute("title")).toBe("/Game/Obstacles/BP_Obstacle_BrokenBridge.BP_Obstacle_BrokenBridge");
    expect(within(step(1).querySelector(".qa-instruction") as HTMLElement).getByRole("button", { name: "IA_Jump" }).className).toBe("asset-link code");
    expect(within(step(1)).getByRole("button", { name: "/Game/Props/SM_Plank.SM_Plank" })).toBeTruthy();
    // A name that does not resolve stays plain, as in chat.
    expect(within(step(1)).queryByRole("button", { name: "BP_Missing_Thing" })).toBeNull();
    expect(step(1).querySelector(".qa-instruction")!.textContent).toContain("BP_Missing_Thing does not matter");
    // The property an auto step reads is never a link.
    expect(within(step(2)).queryByRole("button")).toBeNull();
    await act(async () => fireEvent.click(map));
    expect(m.openAsset).toHaveBeenCalledWith("/Game/Maps/L_WG_Meadow.L_WG_Meadow");
  });

  it("links the script path under the title to the script asset", async () => {
    mount({});
    const path = screen.getByRole("button", { name: SCRIPT });
    expect(path.closest(".qa-script-path")).toBeTruthy();
    expect(path.getAttribute("title")).toBe(`${SCRIPT}.TS_Playtest_BP_Obstacle_BrokenBridge`);
    await act(async () => fireEvent.click(path));
    expect(m.openAsset).toHaveBeenCalledWith(`${SCRIPT}.TS_Playtest_BP_Obstacle_BrokenBridge`);
  });

  it("lists a step's arrange and act with the assets they name linked", () => {
    mount({});
    const setup = step(1).querySelector(".qa-setup")!;
    expect(setup.textContent).toBe("Arrange: spawn BP_WolfAct: press IA_Jump");
    expect(within(setup as HTMLElement).getByRole("button", { name: "BP_Wolf" }).getAttribute("title")).toBe("/Game/AI/BP_Wolf.BP_Wolf");
    expect(within(setup as HTMLElement).getByRole("button", { name: "IA_Jump" }).getAttribute("title")).toBe("/Game/Input/IA_Jump.IA_Jump");
    expect(step(0).querySelector(".qa-setup")).toBeNull();
  });

  it("shows step text quoted elsewhere through the same links", () => {
    render(<StepText text="Step 2 (Press [IA_Jump](/Game/Input/IA_Jump.IA_Jump) at the gap)" />);
    expect(screen.getByRole("button", { name: "IA_Jump" }).getAttribute("title")).toBe("/Game/Input/IA_Jump.IA_Jump");
  });
});
