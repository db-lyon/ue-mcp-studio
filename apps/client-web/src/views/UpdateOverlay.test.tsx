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
    expect(screen.getByText("Update ready,")).toBeTruthy();
    expect(screen.getByText("restarts when the current turn finishes.", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByText("Restart now"));
    expect(screen.getByText("Restarting now stops the turn in progress.", { exact: false })).toBeTruthy();
    expect(posted).toEqual([]);
    fireEvent.click(screen.getByText("Restart and stop the turn"));
    await waitFor(() => expect(posted).toEqual(["/v1/ext/studio/updates/deferred/now"]));
  });
});
