// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AssetRef, AssetResolution } from "@ue-mcp-studio/shared";

vi.mock("../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return {
    ApiError,
    api: { openAsset: vi.fn(async (path: string) => ({ path, alreadyOpen: false })), resolveAssets: vi.fn(), reportAssetMiss: vi.fn(async () => undefined) },
  };
});
import { ApiError, api } from "../api";
import { AssetLinks, AssetLinksContext, AssetTranscriptContext, RETRY_MS, assetCandidates, splitText } from "./asset-links";
import { TOAST_MS } from "./AssetLink";
import { Entry, Reply, ToolCall } from "./Transcript";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";

describe("asset candidates in a reply", () => {
  it("takes the asset-like inline code and leaves plain words alone", () => {
    expect(assetCandidates("Next is the landscape placer `SG_PlaceAssembly`, then its `Owner`.")).toEqual(["SG_PlaceAssembly"]);
  });

  it("takes bare object paths in text, and skips fenced code, file paths and commands", () => {
    const md = [
      "Saved /Game/PCG/SG_A and `/Game/PCG/SG_B.SG_B`.",
      "Edit `Source/Vale/Vale.Build.cs` then run `npm run build` in /c/Users/me.",
      "```",
      "SG_InFence /Game/PCG/SG_Fenced",
      "```",
      "`BP_Door` twice: `BP_Door`. Not `/Game/X/Y.uasset`, `UE_LOG` or `AActor`.",
    ].join("\n");
    expect(assetCandidates(md)).toEqual(["/Game/PCG/SG_A", "/Game/PCG/SG_B.SG_B", "BP_Door"]);
  });

  it("never looks up a markdown asset link: it is already exact", () => {
    expect(assetCandidates("Made [SG_A](/Game/PCG/SG_A.SG_A) and [`BP_B`](/Game/BP/BP_B).")).toEqual([]);
  });

  it("splits plain text around paths for a tool's input and result", () => {
    expect(splitText('{"assetPath": "/Game/A/BP_X"}')).toEqual([
      { text: '{"assetPath": "', asset: false },
      { text: "/Game/A/BP_X", asset: true },
      { text: '"}', asset: false },
    ]);
  });
});

type Results = Record<string, AssetResolution>;
/** A resolver answering from a table keyed by token, or by "at|token" for a name in a message. */
const fromTable = (results: Results) => async (refs: AssetRef[]) =>
  refs.map((r) => results[r.at === undefined ? r.token : `${r.at}|${r.token}`] ?? results[r.token] ?? { status: "unresolved" as const });

describe("the resolution store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks in one debounced batch, one request at a time", async () => {
    let release: (v: AssetResolution[]) => void = () => {};
    const resolve = vi.fn((_refs: AssetRef[], _id: string | null) => new Promise<AssetResolution[]>((r) => (release = r)));
    const s = new AssetLinks(resolve, "s1", 50);
    s.request("BP_A", 4);
    s.request("BP_B", 4);
    s.request("BP_A", 4);
    await vi.advanceTimersByTimeAsync(60);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith([{ token: "BP_A", at: 4 }, { token: "BP_B", at: 4 }], "s1");
    s.request("BP_C");
    await vi.advanceTimersByTimeAsync(60);
    expect(resolve).toHaveBeenCalledTimes(1);
    release([{ status: "resolved", paths: ["/Game/BP_A.BP_A"] }, { status: "unresolved" }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith([{ token: "BP_C" }], "s1");
    expect(s.state("BP_A", 4)).toEqual({ status: "resolved", paths: ["/Game/BP_A.BP_A"] });
    expect(s.state("BP_B", 4)).toEqual({ status: "unresolved" });
  });

  it("asks for a name once per message, and for a path once", async () => {
    const resolve = vi.fn(fromTable({
      "1|SG_X": { status: "resolved", paths: ["/Game/Lib/SG_X.SG_X"] },
      "5|SG_X": { status: "resolved", paths: ["/Game/Reg/SG_X.SG_X"] },
    }));
    const s = new AssetLinks(resolve, "s1", 10);
    s.request("SG_X", 1);
    s.request("SG_X", 5);
    s.request("/Game/Lib/SG_X", 1);
    s.request("/Game/Lib/SG_X", 5);
    await vi.advanceTimersByTimeAsync(20);
    expect(resolve).toHaveBeenCalledWith([{ token: "SG_X", at: 1 }, { token: "SG_X", at: 5 }, { token: "/Game/Lib/SG_X" }], "s1");
    expect(s.state("SG_X", 1)).toEqual({ status: "resolved", paths: ["/Game/Lib/SG_X.SG_X"] });
    expect(s.state("SG_X", 5)).toEqual({ status: "resolved", paths: ["/Game/Reg/SG_X.SG_X"] });
  });

  it("keeps a token plain while the agent cannot answer, and asks again later", async () => {
    const resolve = vi.fn<(r: AssetRef[]) => Promise<AssetResolution[]>>()
      .mockRejectedValueOnce(new Error("daemon down"))
      .mockResolvedValueOnce([{ status: "retry" }])
      .mockResolvedValueOnce([{ status: "resolved", paths: ["/Game/BP_A.BP_A"] }]);
    const s = new AssetLinks(resolve, null, 10);
    s.request("BP_A");
    await vi.advanceTimersByTimeAsync(20);
    expect(s.state("BP_A").status).toBe("pending");
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(s.state("BP_A").status).toBe("pending");
    await vi.advanceTimersByTimeAsync(RETRY_MS[1]);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(s.state("BP_A").status).toBe("resolved");
  });
});

describe("asset links in the transcript", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const withStore = (results: Results) => {
    const resolve = vi.fn(fromTable(results));
    const store = new AssetLinks(resolve, "s1", 10);
    return { resolve, store, wrap: (ui: React.ReactNode) => <AssetLinksContext.Provider value={store}>{ui}</AssetLinksContext.Provider> };
  };

  it("renders a markdown asset link as the short name in code, opening exactly its path", async () => {
    const { resolve, wrap } = withStore({});
    render(wrap(<Reply at={2} text="Duplicated into [SG_PlaceChildAssembly](/Game/Environment/PCG/Library/SG_PlaceChildAssembly.SG_PlaceChildAssembly)." />));
    const link = screen.getByRole("button", { name: "SG_PlaceChildAssembly" });
    expect(link.className).toBe("asset-link code");
    expect(link.getAttribute("title")).toBe("/Game/Environment/PCG/Library/SG_PlaceChildAssembly.SG_PlaceChildAssembly");
    expect(document.querySelector("a")).toBeNull();
    await act(async () => fireEvent.click(link));
    expect(api.openAsset).toHaveBeenCalledWith("/Game/Environment/PCG/Library/SG_PlaceChildAssembly.SG_PlaceChildAssembly");
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("takes a package path, a path with a subobject and a code label, and keeps web links as links", async () => {
    const { wrap } = withStore({});
    render(wrap(<Reply text={"[BP_Door](/Game/Doors/BP_Door), [`M_Rock`](/Game/M/M_Rock.M_Rock:Sub) and [docs](https://example.com/Game/A)."} />));
    expect(screen.getByRole("button", { name: "BP_Door" }).getAttribute("title")).toBe("/Game/Doors/BP_Door.BP_Door");
    expect(screen.getByRole("button", { name: "M_Rock" }).getAttribute("title")).toBe("/Game/M/M_Rock.M_Rock");
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/Game/A");
  });

  it("shows a rooted link that is not an asset as its text, never a web link", () => {
    const { wrap } = withStore({});
    render(wrap(<Reply text="See [the engine type](/Script/Engine.Actor) and [this](/Game/A/B.uasset)." />));
    expect(document.querySelector("a")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/See the engine type and this\./)).toBeTruthy();
  });

  it("renders plain code first, then upgrades a name resolved for its message to a link", async () => {
    const { resolve, wrap } = withStore({ "7|SG_PlaceAssembly": { status: "resolved", paths: ["/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly"] } });
    render(wrap(<Reply at={7} text="Next is the landscape placer `SG_PlaceAssembly`, then `Owner`." />));
    expect(screen.queryByRole("button", { name: "SG_PlaceAssembly" })).toBeNull();
    expect(screen.getByText("SG_PlaceAssembly").tagName).toBe("CODE");
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(resolve).toHaveBeenCalledWith([{ token: "SG_PlaceAssembly", at: 7 }], "s1");
    const link = screen.getByRole("button", { name: "SG_PlaceAssembly" });
    expect(link.className).toContain("asset-link code");
    expect(link.getAttribute("title")).toBe("/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly");
    expect(screen.getByText("Owner").tagName).toBe("CODE");
    await act(async () => fireEvent.click(link));
    expect(api.openAsset).toHaveBeenCalledWith("/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly");
    expect(api.reportAssetMiss).not.toHaveBeenCalled();
  });

  it("asks for a reply's names at its own index in the session's transcript", async () => {
    const { resolve, wrap } = withStore({});
    const transcript: TranscriptEntry[] = [
      { kind: "user", text: "go", at: "" },
      { kind: "assistant", text: "`SG_A`", at: "" },
      { kind: "assistant", text: "`SG_A` again", at: "" },
    ];
    render(wrap(<AssetTranscriptContext.Provider value={transcript}><Entry entry={transcript[1]} /><Entry entry={transcript[2]} /></AssetTranscriptContext.Provider>));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(resolve).toHaveBeenCalledWith([{ token: "SG_A", at: 1 }, { token: "SG_A", at: 2 }], "s1");
  });

  it("leaves fenced code as it is", async () => {
    const { wrap } = withStore({ BP_A: { status: "resolved", paths: ["/Game/BP_A.BP_A"] } });
    render(wrap(<Reply text={"```\nBP_A\n```"} />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falls back to the chooser for a name still ambiguous, and reports the miss", async () => {
    const paths = ["/Game/A/M_Rock.M_Rock", "/Game/B/M_Rock.M_Rock"];
    const { wrap } = withStore({ M_Rock: { status: "resolved", paths } });
    render(wrap(<Reply text="The `M_Rock` material." />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(api.reportAssetMiss).toHaveBeenCalledTimes(1);
    expect(api.reportAssetMiss).toHaveBeenCalledWith("M_Rock", 2);
    fireEvent.click(screen.getByRole("button", { name: "M_Rock" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(paths);
    await act(async () => fireEvent.click(items[1]));
    expect(api.openAsset).toHaveBeenCalledWith(paths[1]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows why an open failed in a small toast that goes away", async () => {
    vi.mocked(api.openAsset).mockRejectedValueOnce(new ApiError(409, "Editor busy"));
    const { wrap } = withStore({ BP_A: { status: "resolved", paths: ["/Game/BP_A.BP_A"] } });
    render(wrap(<Reply text="`BP_A`" />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "BP_A" })));
    expect(screen.getByRole("status").textContent).toBe("Editor busy");
    await act(() => vi.advanceTimersByTimeAsync(TOAST_MS + 10));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("links bare paths in a reply and, once opened, in a tool call's result", async () => {
    const { wrap } = withStore({ "/Game/A/BP_X": { status: "resolved", paths: ["/Game/A/BP_X.BP_X"] } });
    render(wrap(<Reply text="Created /Game/A/BP_X." />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(screen.getByRole("button", { name: "/Game/A/BP_X" }).className).toBe("asset-link");
    cleanup();
    const call = { id: "1", name: "ue_mcp", input: { action: "call", category: "blueprint", method: "create", args: { assetPath: "/Game/A/BP_X" } }, outcome: "done" as const, result: '{"created":true}', startedAt: "" };
    const { container } = render(wrap(<ToolCall call={call} />));
    expect(screen.queryByRole("button", { name: "/Game/A/BP_X" })).toBeNull();
    const details = container.querySelector("details")!;
    details.open = true;
    await act(async () => fireEvent(details, new Event("toggle")));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(screen.getByRole("button", { name: "/Game/A/BP_X" })).toBeTruthy();
  });

  it("renders plain text outside a session, and exact links still work", () => {
    render(<Reply text="`SG_PlaceAssembly` and [SG_B](/Game/PCG/SG_B)" />);
    expect(screen.getByText("SG_PlaceAssembly").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "SG_B" }).getAttribute("title")).toBe("/Game/PCG/SG_B.SG_B");
  });
});
