// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdateWaiting } from "./UpdateOverlay";

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
