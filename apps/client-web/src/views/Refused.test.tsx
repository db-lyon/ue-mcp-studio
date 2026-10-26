// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { RefusedScreen, updateUeMcp, useRefusal } from "./Refused";

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

  it("installs the floor through the daemon's update routes, and says to restart the editor", async () => {
    const fetch = vi.fn(async (url: string) => (url.startsWith("/v1/update?") ? json({ latest: "1.4.10", target: null }) : json({ ok: true, version: "1.4.11-beta.6", state: "applied" })));
    vi.stubGlobal("fetch", fetch);
    render(<RefusedScreen refusal={{ needs: "1.4.11-beta.6", have: "1.4.10" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Update ue-mcp" }));
    await screen.findByText("ue-mcp 1.4.11-beta.6 is installed. Restart the editor to finish.");
    expect(fetch.mock.calls[0][0]).toBe("/v1/update?channel=beta");
    expect(fetch.mock.calls[1][0]).toBe("/v1/update/apply");
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))).toEqual({ version: "1.4.11-beta.6" });
  });

  it("takes the channel's newest when it is at least the floor", async () => {
    const send = vi.fn(async (url: string) => (url.startsWith("/v1/update?") ? json({ latest: "1.4.11" }) : json({ ok: true })));
    expect(await updateUeMcp("1.4.11-beta.6", send as unknown as typeof fetch)).toEqual({ ok: true, version: "1.4.11" });
  });

  it("shows the install's own error and keeps the button", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.startsWith("/v1/update?") ? json({ latest: null }) : json({ ok: false, error: "no prebuilt bridge for UE 5.7" }, 500))));
    render(<RefusedScreen refusal={{ needs: "1.4.11-beta.6", have: "1.4.10" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Update ue-mcp" }));
    await screen.findByText("no prebuilt bridge for UE 5.7");
    expect(screen.getByRole("button", { name: "Update ue-mcp" })).toBeTruthy();
  });
});
