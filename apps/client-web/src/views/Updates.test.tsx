// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdatesCard, readyLine, updateSteps, waiting } from "./Updates";
import { UpdateRunner } from "./UpdateOverlay";

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

  it("names each part that has something newer", () => {
    expect(readyLine({ studio: studio(false, false), ueMcp: ueMcp(true) })).toBe("Ready to install: ue-mcp 1.4.0-beta.2.");
    expect(readyLine({ studio: studio(true, true), ueMcp: ueMcp(true) })).toBe("Ready to install: ue-mcp 1.4.0-beta.2, the editor plugin 0.1.0-beta.9 and Studio 0.1.0-beta.10.");
  });

  it("shows one Update button that runs every step in order, and stops at the first failure", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/ext/studio/updates/run") return new Response(JSON.stringify({ run: null }));
      if (!init?.method) return new Response(JSON.stringify(url.includes("/ext/studio/") ? studio(true, true) : ueMcp(true)));
      posted.push(url);
      return url.endsWith("/plugin")
        ? new Response(JSON.stringify({ error: "the editor would not stop" }), { status: 500 })
        : new Response(JSON.stringify({ ok: true }));
    }));
    render(<><UpdatesCard /><UpdateRunner streaming events={[]} /></>);
    await waitFor(() => expect(screen.getByText("Update available")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Update" })).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update" })));
    await waitFor(() => expect(screen.getByText("the editor would not stop")).toBeTruthy());
    expect(posted).toEqual(["/v1/update/apply", "/v1/ext/studio/updates/plugin"]);
    // ue-mcp's update fetches the binaries for the version itself; the file name is not a source to pass.
    const apply = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.find(([u]) => u === "/v1/update/apply")!;
    expect(JSON.parse(String(apply[1]!.body))).toEqual({ version: "1.4.0-beta.2" });
    expect(screen.getByRole("dialog", { name: "Update stopped" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says up to date with nothing to do", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/ext/studio/") ? studio(false, false) : ueMcp(false)))));
    render(<UpdatesCard />);
    await waitFor(() => expect(screen.getByText("Everything is up to date.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("picks the update up again in the page that loads after the editor restarted for the plugin", async () => {
    let kept: unknown = { target: null, at: Date.now(), steps: [{ key: "plugin", state: "active" }, { key: "studio", state: "pending" }] };
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/ext/studio/updates/run") {
        if (init?.method === "PUT") kept = (JSON.parse(String(init.body)) as { run: unknown }).run;
        return new Response(JSON.stringify({ run: kept }));
      }
      if (init?.method) return posted.push(url), new Response(JSON.stringify({ started: true }));
      return new Response(JSON.stringify(url.includes("/ext/studio/") ? studio(true, false) : ueMcp(false)));
    }));
    render(<UpdateRunner streaming events={[]} />);
    await waitFor(() => expect(posted).toEqual(["/v1/ext/studio/updates/studio"]));
    expect(screen.getByRole("dialog", { name: "Updating" }).textContent).toMatch(/This panel reloads when it is back/);
    expect((kept as { steps: Array<{ state: string }> }).steps.map((s) => s.state)).toEqual(["done", "active"]);
  });
});
