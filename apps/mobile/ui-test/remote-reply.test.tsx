// /remote in the app: the command taken out of the composer, and the reply
// with the pairing code, the sign-in or the Upgrade action, as the web client's.
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { Linking } from "react-native";
import { HttpError } from "@ue-mcp-studio/client-core";
import type { RemoteApproval, RemotePairing, RemoteStatus } from "@ue-mcp-studio/shared";
import { RemoteReply, useRemoteCommand, type RemoteState } from "../src/screens/chat/composer/RemoteReply";
import { RemoteChatCard } from "../src/screens/chat/composer/remote/RemoteChatCard";
import { PairingCode } from "../src/screens/chat/composer/remote/PairingCode";
import { stopCheckoutWatch } from "../src/screens/chat/composer/remote/remote-available";
import { clip } from "./mocks/clipboard";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";
import { ProjectContext, type ProjectNav } from "../src/nav";
import type { StudioApi } from "@ue-mcp-studio/client-core";

const REMOTE_ROUTES = ["remoteAvailable", "billingCheckout", "billingPortal", "remoteStatus", "setRemote", "pairRemote", "remoteBrowsers", "remoteApprovals", "decideRemoteApproval", "revokeRemoteBrowser"] as const;

/** The fake API with remote control's routes, each answered as a computer on a paid plan answers. */
function remoteApi() {
  const api = fakeApi() as ReturnType<typeof fakeApi> & Record<(typeof REMOTE_ROUTES)[number], ReturnType<typeof vi.fn>>;
  for (const n of REMOTE_ROUTES) api[n] = vi.fn(() => new Promise(() => undefined));
  api.remoteApprovals.mockResolvedValue({ approvals: [] });
  api.remoteBrowsers.mockResolvedValue({ browsers: [{ id: "b1", label: "Android", addedAt: "2026-11-03T19:15:57.234Z" }] });
  return api;
}

const ONLINE: RemoteStatus = { enabled: true, relay: "https://remote.ue-mcp.com", state: "online", login: "dev", since: "2026-11-04T12:00:00Z" } as RemoteStatus;
const pairing = (ms: number): RemotePairing => ({ url: "https://remote.ue-mcp.com/p/abc", expiresAt: new Date(Date.now() + ms).toISOString(), svg: "<svg viewBox=\"0 0 4 4\"><rect width=\"4\" height=\"4\"/></svg>" }) as RemotePairing;
const button = (name: string) => screen.getByRole("button", { name });

const state = (over: Partial<RemoteState>): RemoteState => ({ available: false, signedIn: true, surface: "hidden", recheck: vi.fn(), ...over });

describe("RemoteChatCard", () => {
  it("turns remote control on, waits for the relay, then shows the code, its link, the time left and the paired browsers", async () => {
    const api = remoteApi();
    api.remoteStatus.mockResolvedValue({ ...ONLINE, enabled: false });
    api.setRemote.mockResolvedValue(ONLINE);
    api.pairRemote.mockResolvedValue(pairing(9 * 60_000 + 41_000));
    renderInProject(<RemoteChatCard onSettings={() => undefined} />, api);
    expect(screen.getByText("Connecting to the relay")).toBeTruthy();
    await settle();
    expect(api.setRemote).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText("Pairing QR code")).toBeTruthy();
    expect(screen.getByText("https://remote.ue-mcp.com/p/abc")).toBeTruthy();
    expect(screen.getByText(/^Works once, for 9:4\d more\.$/)).toBeTruthy();
    expect(screen.getByText("Android")).toBeTruthy();
    expect(button("Manage paired browsers in Settings")).toBeTruthy();
    fireEvent.click(button("Copy link"));
    await settle();
    expect(clip.text).toBe("https://remote.ue-mcp.com/p/abc");
    expect(button("Copied")).toBeTruthy();
  });

  it("offers New code once the code runs out, and shows the new one", async () => {
    const api = remoteApi();
    api.remoteStatus.mockResolvedValue(ONLINE);
    api.pairRemote.mockResolvedValueOnce(pairing(-1000)).mockResolvedValueOnce(pairing(60_000));
    renderInProject(<RemoteChatCard />, api);
    await settle();
    expect(screen.getByText("This code has expired.")).toBeTruthy();
    fireEvent.click(button("New code"));
    await settle();
    expect(screen.getByLabelText("Pairing QR code")).toBeTruthy();
  });

  it("says why the relay cannot be reached, and Retry starts again", async () => {
    const api = remoteApi();
    api.remoteStatus.mockResolvedValueOnce({ enabled: true, relay: "https://remote.ue-mcp.com", state: "error", reason: "The relay refused the connection (HTTP 502)." } as RemoteStatus);
    renderInProject(<RemoteChatCard />, api);
    await settle();
    expect(screen.getByText(/The relay refused the connection \(HTTP 502\)\./)).toBeTruthy();
    expect(screen.getByText(/The code shows here once it connects\./)).toBeTruthy();
    api.remoteStatus.mockResolvedValue(ONLINE);
    api.pairRemote.mockResolvedValue(pairing(60_000));
    fireEvent.click(button("Retry"));
    await settle();
    expect(screen.getByLabelText("Pairing QR code")).toBeTruthy();
  });

  it("a 403 from the pairing says the plan is needed, with nothing to wait for", async () => {
    const api = remoteApi();
    api.remoteStatus.mockResolvedValue(ONLINE);
    api.pairRemote.mockRejectedValue(new HttpError(403, "forbidden"));
    renderInProject(<RemoteChatCard />, api);
    await settle();
    expect(screen.getByText("Remote control needs a Pro or Studio plan on this account.")).toBeTruthy();
    expect(screen.queryByText(/The code shows here once it connects\./)).toBeNull();
  });

  it("a device asking to be allowed shows its code with Allow and Deny, and the answer goes to the computer", async () => {
    const api = remoteApi();
    const asking: RemoteApproval = { id: "a1", label: "iPhone (Safari)", code: "482913", expiresAt: new Date(Date.now() + 110_000).toISOString(), project: "Vale" } as RemoteApproval;
    api.remoteStatus.mockResolvedValue(ONLINE);
    api.pairRemote.mockResolvedValue(pairing(60_000));
    api.remoteApprovals.mockResolvedValue({ approvals: [asking] });
    api.decideRemoteApproval.mockResolvedValue({ ok: true });
    renderInProject(<RemoteChatCard />, api);
    await settle();
    expect(screen.getByLabelText("iPhone (Safari) wants to control Vale")).toBeTruthy();
    expect(screen.getByText("482 913")).toBeTruthy();
    fireEvent.click(button("Allow"));
    await settle();
    expect(api.decideRemoteApproval).toHaveBeenCalledWith("a1", true);
    expect(screen.queryByLabelText("iPhone (Safari) wants to control Vale")).toBeNull();
  });

  it("Deny refuses the device", async () => {
    const api = remoteApi();
    api.remoteStatus.mockResolvedValue(ONLINE);
    api.pairRemote.mockResolvedValue(pairing(60_000));
    api.remoteApprovals.mockResolvedValue({ approvals: [{ id: "a2", label: "Pixel", code: "111222", expiresAt: new Date(Date.now() + 60_000).toISOString(), project: "Vale" }] });
    api.decideRemoteApproval.mockResolvedValue({ ok: true });
    renderInProject(<RemoteChatCard />, api);
    await settle();
    fireEvent.click(button("Deny"));
    await settle();
    expect(api.decideRemoteApproval).toHaveBeenCalledWith("a2", false);
  });

  it("Remove unpairs a browser", async () => {
    const api = remoteApi();
    api.remoteStatus.mockResolvedValue(ONLINE);
    api.pairRemote.mockResolvedValue(pairing(60_000));
    api.revokeRemoteBrowser.mockResolvedValue(undefined);
    renderInProject(<RemoteChatCard />, api);
    await settle();
    fireEvent.click(button("Remove"));
    await settle();
    expect(api.revokeRemoteBrowser).toHaveBeenCalledWith("b1");
    expect(screen.queryByText("Android")).toBeNull();
  });
});

describe("PairingCode", () => {
  it("draws the QR from the agent's svg", () => {
    renderInProject(<PairingCode pairing={pairing(60_000)} onRenew={() => undefined} />, remoteApi());
    expect(screen.getByTestId("pairing-qr").innerHTML).toContain("<rect");
  });
});

describe("RemoteReply", () => {
  it("a free signed-in account gets the plan note and Upgrade, which opens the checkout in the browser", async () => {
    const api = remoteApi();
    api.billingCheckout.mockResolvedValue({ url: "https://checkout.stripe.test/c/1", provider: "stripe" });
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    const dismiss = vi.fn();
    renderInProject(<RemoteReply remote={state({ available: false, signedIn: true })} onDismiss={dismiss} />, api);
    expect(screen.getByText("Remote control lets you use this project from your phone. It needs a Pro or Studio plan.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Yearly" }));
    fireEvent.click(button("Upgrade to Pro"));
    await settle();
    expect(api.billingCheckout).toHaveBeenCalledWith({ plan: "pro", interval: "year" });
    expect(open).toHaveBeenCalledWith("https://checkout.stripe.test/c/1");
    expect(screen.getByText("Checkout opened in your browser. Remote control turns on here once the payment goes through.")).toBeTruthy();
    stopCheckoutWatch();
    fireEvent.click(button("Dismiss"));
    expect(dismiss).toHaveBeenCalled();
    open.mockRestore();
  });

  it("an account that already pays is sent to its portal", async () => {
    const api = remoteApi();
    api.billingCheckout.mockRejectedValue(new HttpError(409, "has a subscription"));
    api.billingPortal.mockResolvedValue({ url: "https://portal.stripe.test/p/1", provider: "stripe" });
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    renderInProject(<RemoteReply remote={state({})} onDismiss={() => undefined} />, api);
    fireEvent.click(button("Upgrade to Pro"));
    await settle();
    expect(open).toHaveBeenCalledWith("https://portal.stripe.test/p/1");
    stopCheckoutWatch();
    open.mockRestore();
  });

  it("a signed-out computer gets the sign-in", () => {
    renderInProject(<RemoteReply remote={state({ signedIn: false })} onDismiss={() => undefined} />, remoteApi());
    expect(screen.getByText("Sign in to your ue-mcp account to use remote control.")).toBeTruthy();
    expect(screen.queryByText("Upgrade to Pro")).toBeNull();
  });

  it("a paid plan says it is on and shows the pairing card", async () => {
    const api = remoteApi();
    api.remoteStatus.mockResolvedValue(ONLINE);
    api.pairRemote.mockResolvedValue(pairing(60_000));
    renderInProject(<RemoteReply remote={state({ available: true, surface: "working" })} onDismiss={() => undefined} onSettings={() => undefined} />, api);
    expect(screen.getByText("Remote control is on for this account.")).toBeTruthy();
    await settle();
    expect(screen.getByLabelText("Pairing QR code")).toBeTruthy();
  });
});

describe("useRemoteCommand", () => {
  function hook(answer: { available: boolean; signedIn: boolean }, initial: string, files = 0) {
    const api = remoteApi();
    api.remoteAvailable.mockResolvedValue(answer);
    const nav: ProjectNav = { project: fakeProject().project, api: api as unknown as StudioApi, push: () => undefined, pop: vi.fn() };
    const saveDraft = vi.fn(() => Promise.resolve());
    const r = renderHook(
      () => {
        const [draft, setDraft] = useState(initial);
        return { draft, cmd: useRemoteCommand({ sessionId: "s1", draft, setDraft, readyFiles: files, saveDraft }) };
      },
      { wrapper: ({ children }) => <ProjectContext.Provider value={nav}>{children}</ProjectContext.Provider> },
    );
    return { ...r, saveDraft };
  }

  it("takes /remote out of the composer and opens the reply in this session", async () => {
    const { result, saveDraft } = hook({ available: false, signedIn: true }, "/remote ");
    await waitFor(() => expect(result.current.cmd.remote.available).toBe(false));
    let took = false;
    act(() => {
      took = result.current.cmd.runRemoteCommand();
    });
    expect(took).toBe(true);
    expect(result.current.draft).toBe("");
    expect(saveDraft).toHaveBeenCalledWith("s1", "");
    expect(result.current.cmd.reply).toBe("s1");
    act(() => result.current.cmd.dismiss());
    expect(result.current.cmd.reply).toBeNull();
  });

  it("/rc is the same command", async () => {
    const { result } = hook({ available: true, signedIn: true }, "/rc");
    await waitFor(() => expect(result.current.cmd.remote.available).toBe(true));
    let took = false;
    act(() => {
      took = result.current.cmd.runRemoteCommand();
    });
    expect(took).toBe(true);
  });

  it("leaves any other message, and /remote with files, to be sent", async () => {
    const other = hook({ available: true, signedIn: true }, "/remote please");
    await waitFor(() => expect(other.result.current.cmd.remote.available).toBe(true));
    expect(other.result.current.cmd.runRemoteCommand()).toBe(false);
    const files = hook({ available: true, signedIn: true }, "/remote", 1);
    await waitFor(() => expect(files.result.current.cmd.remote.available).toBe(true));
    expect(files.result.current.cmd.runRemoteCommand()).toBe(false);
  });

  it("lists /remote in the menu only on a paid plan while the plan is not offered", async () => {
    const paid = hook({ available: true, signedIn: true }, "");
    await waitFor(() => expect(paid.result.current.cmd.commands.some((c) => c.name === "remote")).toBe(true));
    const free = hook({ available: false, signedIn: true }, "");
    await waitFor(() => expect(free.result.current.cmd.remote.available).toBe(false));
    expect(free.result.current.cmd.commands.some((c) => c.name === "remote")).toBe(false);
  });
});
