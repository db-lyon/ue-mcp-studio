// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VersionNotice } from "./VersionNotice";
import type { DaemonState } from "../state";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const daemon: DaemonState = { health: null, error: null, streaming: true, events: [], refresh: () => {} };

function stub(notice: { installed: string; current: string } | null) {
  const posted: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push({ url, body });
      return new Response(JSON.stringify(url.endsWith("/keep") ? { notice: null } : { ok: true, started: true }), { status: url.endsWith("/keep") ? 200 : 202 });
    }
    return new Response(JSON.stringify({ notice }));
  }));
  return posted;
}

describe("the Studio version notice (ue-mcp#1619)", () => {
  it("says another project installed a newer Studio, and Update moves this project to it", async () => {
    const posted = stub({ installed: "0.1.25", current: "0.1.23" });
    render(<VersionNotice daemon={daemon} />);
    await screen.findByText("Studio 0.1.25 was installed by another project. This project uses 0.1.23.");
    fireEvent.click(screen.getByText("Update this project"));
    await waitFor(() => expect(posted).toEqual([{ url: "/v1/ext/studio/version-notice/update", body: { version: "0.1.25" } }]));
    expect(screen.getByText("Updating")).toBeTruthy();
  });

  it("Keep hides it and remembers the version kept past", async () => {
    const posted = stub({ installed: "0.1.25", current: "0.1.23" });
    render(<VersionNotice daemon={daemon} />);
    fireEvent.click(await screen.findByText("Keep 0.1.23"));
    await waitFor(() => expect(screen.queryByText(/was installed by another project/)).toBeNull());
    expect(posted).toEqual([{ url: "/v1/ext/studio/version-notice/keep", body: { version: "0.1.25" } }]);
  });

  it("shows nothing when this project is on the newest, or the agent is older than the route", async () => {
    stub(null);
    const { container } = render(<VersionNotice daemon={daemon} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    cleanup();
    const again = render(<VersionNotice daemon={daemon} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(again.container.textContent).toBe("");
  });
});
