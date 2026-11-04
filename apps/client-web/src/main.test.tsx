// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

const seen = vi.hoisted(() => ({ guarded: null as boolean | null, original: null as unknown }));
vi.mock("./App", () => ({
  App: () => {
    useEffect(() => {
      seen.guarded = window.fetch !== seen.original;
    }, []);
    return null;
  },
}));

afterEach(() => {
  vi.resetModules();
  delete (window as unknown as { __studioRemotePage?: boolean }).__studioRemotePage;
  document.body.innerHTML = "";
});

async function boot(remote: boolean): Promise<void> {
  document.body.innerHTML = '<div id="root"></div>';
  (window as unknown as { __studioRemotePage?: boolean }).__studioRemotePage = remote;
  const original = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  window.fetch = original as unknown as typeof fetch;
  seen.original = original;
  seen.guarded = null;
  await import("./main");
  // The first import transforms the page's whole module graph; on a busy machine that alone can pass the default second.
  await vi.waitFor(() => expect(seen.guarded).not.toBeNull(), { timeout: 20_000, interval: 20 });
}

describe("the page's entry point", () => {
  it("in a paired browser, guards fetch before any view mounts, so the first requests wait for the PIN", async () => {
    await boot(true);
    expect(seen.guarded).toBe(true);
  }, 30_000);

  it("on the computer, leaves fetch alone", async () => {
    await boot(false);
    expect(seen.guarded).toBe(false);
  }, 30_000);
});
