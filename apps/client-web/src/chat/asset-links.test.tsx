// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AssetResolution } from "@ue-mcp-studio/shared";

vi.mock("../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { ApiError, api: { openAsset: vi.fn(async (path: string) => ({ path, alreadyOpen: false })), resolveAssets: vi.fn() } };
});
import { ApiError, api } from "../api";
import { AssetLinks, AssetLinksContext, RETRY_MS, assetCandidates, splitText } from "./asset-links";
import { TOAST_MS } from "./AssetLink";
import { Reply, ToolCall } from "./Transcript";

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

  it("splits plain text around paths for a tool's input and result", () => {
    expect(splitText('{"assetPath": "/Game/A/BP_X"}')).toEqual([
      { text: '{"assetPath": "', asset: false },
      { text: "/Game/A/BP_X", asset: true },
      { text: '"}', asset: false },
    ]);
  });
});

describe("the resolution store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks in one debounced batch, one request at a time", async () => {
    let release: (v: Record<string, AssetResolution>) => void = () => {};
    const resolve = vi.fn(() => new Promise<Record<string, AssetResolution>>((r) => (release = r)));
    const s = new AssetLinks(resolve, "s1", 50);
    s.request("BP_A");
    s.request("BP_B");
    s.request("BP_A");
    await vi.advanceTimersByTimeAsync(60);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(["BP_A", "BP_B"], "s1");
    s.request("BP_C");
    await vi.advanceTimersByTimeAsync(60);
    expect(resolve).toHaveBeenCalledTimes(1);
    release({ BP_A: { status: "resolved", paths: ["/Game/BP_A.BP_A"] }, BP_B: { status: "unresolved" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith(["BP_C"], "s1");
    expect(s.state("BP_A")).toEqual({ status: "resolved", paths: ["/Game/BP_A.BP_A"] });
    expect(s.state("BP_B")).toEqual({ status: "unresolved" });
  });

  it("keeps a token plain while the agent cannot answer, and asks again later", async () => {
    const resolve = vi.fn<(t: string[]) => Promise<Record<string, AssetResolution>>>()
      .mockRejectedValueOnce(new Error("daemon down"))
      .mockResolvedValueOnce({ BP_A: { status: "retry" } })
      .mockResolvedValueOnce({ BP_A: { status: "resolved", paths: ["/Game/BP_A.BP_A"] } });
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

  const withStore = (results: Record<string, AssetResolution>) => {
    const store = new AssetLinks(async (tokens) => Object.fromEntries(tokens.map((t) => [t, results[t] ?? { status: "unresolved" }])), "s1", 10);
    return { store, wrap: (ui: React.ReactNode) => <AssetLinksContext.Provider value={store}>{ui}</AssetLinksContext.Provider> };
  };

  it("renders plain code first, then upgrades a resolved name to a link that opens it", async () => {
    const { wrap } = withStore({ SG_PlaceAssembly: { status: "resolved", paths: ["/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly"] } });
    render(wrap(<Reply text="Next is the landscape placer `SG_PlaceAssembly`, then `Owner`." />));
    expect(screen.queryByRole("button", { name: "SG_PlaceAssembly" })).toBeNull();
    expect(screen.getByText("SG_PlaceAssembly").tagName).toBe("CODE");
    await act(() => vi.advanceTimersByTimeAsync(20));
    const link = screen.getByRole("button", { name: "SG_PlaceAssembly" });
    expect(link.className).toContain("asset-link code");
    expect(link.getAttribute("title")).toBe("/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly");
    expect(screen.getByText("Owner").tagName).toBe("CODE");
    await act(async () => fireEvent.click(link));
    expect(api.openAsset).toHaveBeenCalledWith("/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly");
  });

  it("leaves fenced code as it is", async () => {
    const { wrap } = withStore({ BP_A: { status: "resolved", paths: ["/Game/BP_A.BP_A"] } });
    render(wrap(<Reply text={"```\nBP_A\n```"} />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a chooser when a name matches several assets", async () => {
    const paths = ["/Game/A/M_Rock.M_Rock", "/Game/B/M_Rock.M_Rock"];
    const { wrap } = withStore({ M_Rock: { status: "resolved", paths } });
    render(wrap(<Reply text="The `M_Rock` material." />));
    await act(() => vi.advanceTimersByTimeAsync(20));
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

  it("renders plain text outside a session", () => {
    render(<Reply text="`SG_PlaceAssembly`" />);
    expect(screen.getByText("SG_PlaceAssembly").tagName).toBe("CODE");
  });
});
