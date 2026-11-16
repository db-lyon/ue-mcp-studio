// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdateScreen, UpdateWaiting } from "./UpdateOverlay";

describe("an update that stopped", () => {
  const failed = { target: null, at: Date.now(), steps: [{ key: "plugin" as const, state: "failed" as const }], error: "The editor plugin did not install." };

  it("offers Retry and Open log on the computer, not only Close", () => {
    const retry = vi.fn();
    const openLog = vi.fn(async () => true);
    render(<UpdateScreen run={failed} slow={false} onClose={() => {}} onRetry={retry} openLog={openLog} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Open log" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(openLog).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("on a paired browser says where to try again instead", () => {
    render(<UpdateScreen run={failed} slow={false} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText("To try again, choose Update in Studio on the computer.")).toBeTruthy();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an update waiting for the turn", () => {
  it("says when it runs, and Restart now warns before it stops the turn", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posted.push(url);
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<UpdateWaiting run={{ target: null, at: Date.now(), steps: [{ key: "studio", state: "deferred" }] }} />);
    expect(screen.getByText("Update ready.")).toBeTruthy();
    expect(screen.getByText("Studio restarts once no turn is in progress.", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByText("Restart now"));
    expect(screen.getByText("Restarting now stops every turn in progress.", { exact: false })).toBeTruthy();
    expect(posted).toEqual([]);
    fireEvent.click(screen.getByText("Restart and stop turns"));
    await waitFor(() => expect(posted).toEqual(["/v1/ext/studio/updates/deferred/now"]));
  });

  it("names the editor when only the editor plugin waits", () => {
    render(<UpdateWaiting run={{ target: null, at: Date.now(), steps: [{ key: "plugin", state: "deferred" }] }} />);
    expect(screen.getByRole("status").textContent).toContain("The editor restarts once no turn is in progress.");
  });

  it("names both when the editor plugin and Studio wait", () => {
    render(<UpdateWaiting run={{ target: null, at: Date.now(), steps: [{ key: "plugin", state: "deferred" }, { key: "studio", state: "deferred" }] }} />);
    expect(screen.getByRole("status").textContent).toContain("The editor and Studio restart once no turn is in progress.");
  });
});
