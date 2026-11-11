// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUpdateCard } from "./Updates";
import { appSlot, type AppUpdate, type Channel } from "./native";

/** A stand-in host keeping one channel, as UE-MCP.exe keeps Studio's file, with each channel's newest release. */
function fakeHost(start: Channel, newest: Record<Channel, string>, extra: Record<string, unknown> = {}) {
  let channel = start;
  const calls: string[] = [];
  const app = {
    getchannel: vi.fn(async () => ({ channel })),
    setchannel: vi.fn(async ({ channel: c }: { channel: Channel }) => {
      calls.push(`set ${c}`);
      channel = c;
      return { ok: true, channel: c };
    }),
    appupdate: vi.fn(async (arg?: { install?: "yes" }): Promise<AppUpdate> => {
      calls.push(arg?.install ? `install ${channel}` : `check ${channel}`);
      const version = newest[channel];
      const newer = version !== "0.1.35-beta.5" && version > "0.1.35-beta.5";
      return arg?.install ? { ok: true, channel, version, newer, started: true } : { ok: true, channel, version, newer };
    }),
    ...extra,
  };
  appSlot().ue = { app: app as unknown as Record<string, (arg?: unknown) => Promise<unknown>> };
  return { app, calls, channel: () => channel };
}

afterEach(() => {
  cleanup();
  delete appSlot().ue;
});

describe("the UE-MCP row: the release channel", () => {
  it("shows the shared channel, the version here and the channel's newest", async () => {
    fakeHost("stable", { stable: "0.1.34", beta: "0.1.35-beta.6" });
    render(<AppUpdateCard version="0.1.35-beta.5" />);
    await screen.findByText("UE-MCP 0.1.35-beta.5. The newest on Stable is 0.1.34.");
    expect((screen.getByRole("radio", { name: "Stable" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Beta" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("radiogroup", { name: "Release channel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update UE-MCP" })).toBeNull();
  });

  it("keeps Beta in the shared setting, checks it again and offers Update when it has a newer release", async () => {
    const h = fakeHost("stable", { stable: "0.1.34", beta: "0.1.35-beta.6" });
    render(<AppUpdateCard version="0.1.35-beta.5" />);
    await screen.findByText(/The newest on Stable/);
    fireEvent.click(screen.getByRole("radio", { name: "Beta" }));
    await screen.findByText("UE-MCP 0.1.35-beta.6 is ready to install from Beta. You have 0.1.35-beta.5.");
    expect(h.app.setchannel).toHaveBeenCalledWith({ channel: "beta" });
    expect(h.channel()).toBe("beta");
    expect(h.calls.slice(-2)).toEqual(["set beta", "check beta"]);
    fireEvent.click(screen.getByRole("button", { name: "Update UE-MCP" }));
    await screen.findByText("Installing. UE-MCP restarts when it is done.");
    expect(h.calls.at(-1)).toBe("install beta");
  });

  it("opens on Beta when Studio chose it", async () => {
    fakeHost("beta", { stable: "0.1.34", beta: "0.1.35-beta.5" });
    render(<AppUpdateCard version="0.1.35-beta.5" />);
    await screen.findByText("UE-MCP 0.1.35-beta.5, the newest on Beta.");
    expect((screen.getByRole("radio", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
  });

  it("says why a check failed, such as GitHub's rate limit", async () => {
    fakeHost("beta", { stable: "0.1.34", beta: "" }, {
      appupdate: vi.fn(async () => ({ ok: false, channel: "beta", error: "GitHub's rate limit for release checks was reached." })),
    });
    render(<AppUpdateCard version="0.1.35-beta.5" />);
    await screen.findByText("Could not check Beta: GitHub's rate limit for release checks was reached.");
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("goes back to the kept channel when it could not be saved", async () => {
    const h = fakeHost("stable", { stable: "0.1.34", beta: "0.1.35-beta.6" }, {
      setchannel: vi.fn(async () => ({ ok: false, error: "The channel could not be saved." })),
    });
    render(<AppUpdateCard version="0.1.35-beta.5" />);
    await screen.findByText(/The newest on Stable/);
    fireEvent.click(screen.getByRole("radio", { name: "Beta" }));
    await screen.findByText("Could not check Stable: The channel could not be saved.");
    await waitFor(() => expect((screen.getByRole("radio", { name: "Stable" }) as HTMLInputElement).checked).toBe(true));
    expect(h.channel()).toBe("stable");
  });
});
