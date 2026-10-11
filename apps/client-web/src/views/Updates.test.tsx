// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdatesCard, updateSteps, waiting } from "./Updates";

const studio = (s: boolean, p: boolean) => ({
  studio: { installed: "0.1.0-beta.9", latest: s ? "0.1.0-beta.10" : "0.1.0-beta.9", available: s },
  plugin: { installed: "0.1.0-beta.4", latest: "0.1.0-beta.9", available: p, location: "project" as const, engine: "5.8" },
});
const ueMcp = (t: boolean) => ({ server: "1.4.0-beta.1", latest: "1.4.0-beta.2", target: t ? "1.4.0-beta.2" : null, binaries: { available: true, file: "b.zip" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("updates", () => {
  it("runs ue-mcp first, then the editor plugin, then Studio, and counts what waits", () => {
    expect(updateSteps({ studio: studio(true, true), ueMcp: ueMcp(true) })).toEqual(["ueMcp", "plugin", "studio"]);
    expect(updateSteps({ studio: studio(false, false), ueMcp: ueMcp(false) })).toEqual([]);
    expect(waiting({ studio: studio(true, false), ueMcp: ueMcp(true) })).toBe(2);
  });

  it("leaves out a ue-mcp release that has no binaries for this binary install, and keeps one for a source install", () => {
    const noBinaries = { ...ueMcp(true), binaries: { available: false, file: "b.zip" } };
    expect(updateSteps({ studio: studio(false, false), ueMcp: noBinaries })).toEqual([]);
    expect(waiting({ studio: studio(false, false), ueMcp: noBinaries })).toBe(0);
    expect(updateSteps({ studio: studio(false, false), ueMcp: { ...ueMcp(true), binaries: null } })).toEqual(["ueMcp"]);
  });

  it("shows one Update button that runs every step in order, and stops at the first failure", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify(url.includes("/ext/studio/") ? studio(true, true) : ueMcp(true)));
      posted.push(url);
      return url.endsWith("/plugin")
        ? new Response(JSON.stringify({ error: "the editor would not stop" }), { status: 500 })
        : new Response(JSON.stringify({ ok: true }));
    }));
    render(<UpdatesCard />);
    await waitFor(() => expect(screen.getByText("Update available")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Update" })).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update" })));
    await waitFor(() => expect(screen.getByText("the editor would not stop")).toBeTruthy());
    expect(posted).toEqual(["/v1/update/apply", "/v1/ext/studio/updates/plugin"]);
  });

  it("says up to date with nothing to do", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/ext/studio/") ? studio(false, false) : ueMcp(false)))));
    render(<UpdatesCard />);
    await waitFor(() => expect(screen.getByText("Studio is up to date.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});
