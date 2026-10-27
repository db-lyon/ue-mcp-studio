// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { RefusedScreen, updateUeMcp, useRefusal } from "./Refused";
import type { StudioBinding } from "../native";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Studio refused for an older ue-mcp", () => {
  it("is read from health when the daemon refused it", () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "not found" }, 404)));
    const health = { version: "1.4.11-beta.4", refusedExtensions: [{ name: "studio", version: "0.1.25", reason: "x", needsUeMcp: "1.4.11-beta.6" }] };
    const { result } = renderHook(() => useRefusal(health));
    expect(result.current).toEqual({ needs: "1.4.11-beta.6", have: "1.4.11-beta.4" });
  });

  it("is read from Studio's refusal route on a daemon that loaded it", async () => {
    const fetch = vi.fn(async () => json({ needs: "1.4.11-beta.6", have: "1.4.10" }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useRefusal({ version: "1.4.10" }));
    await waitFor(() => expect(result.current).toEqual({ needs: "1.4.11-beta.6", have: "1.4.10" }));
    expect(fetch).toHaveBeenCalledWith("/v1/ext/studio/refusal", expect.anything());
  });

  it("is null when Studio runs: no refusal in health, no refusal route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "not found" }, 404)));
    const { result } = renderHook(() => useRefusal({ version: "1.4.11-beta.6", refusedExtensions: [] }));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("says what Studio needs and what is installed, with one button", () => {
    render(<RefusedScreen refusal={{ needs: "1.4.11-beta.6", have: "1.4.10" }} />);
    expect(screen.getByRole("heading").textContent?.replace(/\s+/g, " ").trim()).toBe("Studio needs ue-mcp 1.4.11-beta.6. You have 1.4.10.");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Update ue-mcp"]);
  });

  it("installs the floor through Studio's refusal route, never the daemon's apply, and says to restart the editor", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => (url.startsWith("/v1/update?") ? json({ latest: "1.4.10", target: null }) : json({ ok: true, version: "1.4.11-beta.6" })));
    vi.stubGlobal("fetch", fetch);
    render(<RefusedScreen refusal={{ needs: "1.4.11-beta.6", have: "1.4.10" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Update ue-mcp" }));
    await screen.findByText("ue-mcp 1.4.11-beta.6 is installed. Restart the editor to finish.");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/v1/update?channel=beta", "/v1/ext/studio/refusal/update"]);
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))).toEqual({ version: "1.4.11-beta.6" });
  });

  it("takes the channel's newest when it is at least the floor", async () => {
    const send = vi.fn(async (url: string) => (url.startsWith("/v1/update?") ? json({ latest: "1.4.11" }) : json({ ok: true })));
    expect(await updateUeMcp("1.4.11-beta.6", send as unknown as typeof fetch, {} as StudioBinding)).toEqual({ ok: true, version: "1.4.11" });
  });

  it("shows the install's own error and keeps the button", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.startsWith("/v1/update?") ? json({ latest: null }) : json({ ok: false, error: "no prebuilt bridge for UE 5.7" }, 500))));
    render(<RefusedScreen refusal={{ needs: "1.4.11-beta.6", have: "1.4.10" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Update ue-mcp" }));
    await screen.findByText("no prebuilt bridge for UE 5.7");
    expect(screen.getByRole("button", { name: "Update ue-mcp" })).toBeTruthy();
  });

  describe("when the daemon refused Studio, so no Studio route is loaded", () => {
    /** The daemon answers 404 for a route of an extension it did not load. */
    const daemon = () => vi.fn(async (url: string, _init?: RequestInit) =>
      url.startsWith("/v1/update?") ? json({ latest: null }) : url === "/v1/ext/studio/refusal/update" ? new Response(null, { status: 404 }) : json({ ok: true }));
    const studioWindow = (start: boolean, results: string[]) => {
      const started: string[] = [];
      const host = {
        startuemcpupdate: vi.fn(async (v: string) => (started.push(v), start)),
        getuemcpupdate: vi.fn(async () => results.shift() ?? ""),
      } as unknown as StudioBinding;
      return { host, started };
    };
    const now = async () => {};

    it("runs the target release's own apply in Studio's window, read back until it ends", async () => {
      const send = daemon();
      const { host, started } = studioWindow(true, ["", "", JSON.stringify({ ok: true })]);
      expect(await updateUeMcp("1.4.11-beta.6", send as unknown as typeof fetch, host, now)).toEqual({ ok: true, version: "1.4.11-beta.6" });
      expect(started).toEqual(["1.4.11-beta.6"]);
      expect(host.getuemcpupdate).toHaveBeenCalledTimes(3);
      expect(send.mock.calls.map((c) => c[0])).not.toContain("/v1/update/apply");
    });

    it("says what the target CLI said when its apply failed", async () => {
      const { host } = studioWindow(true, [JSON.stringify({ ok: false, error: "ue-mcp 1.4.11-beta.6 update failed:\nno prebuilt bridge for UE 5.7" })]);
      expect(await updateUeMcp("1.4.11-beta.6", daemon() as unknown as typeof fetch, host, now)).toEqual({
        ok: false, version: "1.4.11-beta.6", error: "ue-mcp 1.4.11-beta.6 update failed:\nno prebuilt bridge for UE 5.7",
      });
    });

    it("says so when the window could not start it, and does not fall back to the daemon's apply", async () => {
      const send = daemon();
      const { host } = studioWindow(false, []);
      const r = await updateUeMcp("1.4.11-beta.6", send as unknown as typeof fetch, host, now);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/could not start ue-mcp 1\.4\.11-beta\.6's update/);
      expect(send.mock.calls.map((c) => c[0])).not.toContain("/v1/update/apply");
    });

    it("gives up on a run that never ends, and says where its output is", async () => {
      const { host } = studioWindow(true, []);
      const r = await updateUeMcp("1.4.11-beta.6", daemon() as unknown as typeof fetch, host, now);
      expect(r).toEqual({ ok: false, version: "1.4.11-beta.6", error: "ue-mcp 1.4.11-beta.6's update did not finish in 15 minutes. Its output is in Saved/UE_MCP_Studio/ue-mcp-update.log." });
    });

    it("falls back to the daemon's apply only with no window to run it, as in a plain browser", async () => {
      const send = daemon();
      expect(await updateUeMcp("1.4.11-beta.6", send as unknown as typeof fetch, {} as StudioBinding, now)).toEqual({ ok: true, version: "1.4.11-beta.6" });
      expect(send.mock.calls.map((c) => c[0])).toEqual(["/v1/update?channel=beta", "/v1/ext/studio/refusal/update", "/v1/update/apply"]);
    });
  });
});
