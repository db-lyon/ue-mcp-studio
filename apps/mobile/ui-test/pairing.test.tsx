import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Alert, Linking } from "react-native";
import type { Transport } from "@ue-mcp-studio/client-core";
import { ApprovalCode, Paired, PairFailed, Pairing, Welcome, type PairFailure } from "../src/screens/Pairing";
import { Scanner } from "../src/screens/Scanner";
import { OfflineBanner } from "../src/views/OfflineBanner";
import { RememberOffer } from "../src/views/remote/RemoteLock";
import { clip } from "./mocks/clipboard";
import { picked } from "./mocks/image-picker";
import { store } from "./mocks/secure-store";
import { settle } from "./helpers";

const relay = vi.hoisted(() => ({
  account: vi.fn(),
  trusted: vi.fn(),
  removeViewer: vi.fn(),
  forgetComputer: vi.fn(),
}));
vi.mock("../src/relay", async (orig) => ({ ...(await orig<object>()), ...relay }));

const { Projects, lastSeen } = await import("../src/screens/Projects");
const { Settings } = await import("../src/screens/Settings");
const { About } = await import("../src/screens/About");

const g = globalThis as Record<string, unknown>;
const LINK = "https://remote.ue-mcp.com/pair#a.b.c";

describe("welcome", () => {
  beforeEach(() => void (clip.text = ""));

  it("scans, or opens the paste panel", () => {
    const seen: string[] = [];
    render(<Welcome onScan={() => seen.push("scan")} onLink={(l) => seen.push(l)} />);
    expect(screen.getByText("Pair this phone")).toBeTruthy();
    fireEvent.click(screen.getByText("Scan pairing code"));
    expect(seen).toEqual(["scan"]);
    expect(screen.queryByLabelText("Pairing link")).toBeNull();
    fireEvent.click(screen.getByText("Paste pairing link"));
    expect(screen.getByText("Paste the pairing link")).toBeTruthy();
    expect(screen.queryByText("Scan pairing code")).toBeNull();
  });

  it("fills the field from a pairing link on the clipboard, and pairs with it", async () => {
    clip.text = `  ${LINK}\n`;
    const links: string[] = [];
    render(<Welcome onScan={() => undefined} onLink={(l) => links.push(l)} />);
    fireEvent.click(screen.getByText("Paste pairing link"));
    await settle();
    expect((screen.getByLabelText("Pairing link") as HTMLInputElement).value).toBe(LINK);
    fireEvent.click(screen.getByText("Pair"));
    expect(links).toEqual([LINK]);
  });

  it("leaves the clipboard alone when it holds something else", async () => {
    clip.text = "a shopping list";
    render(<Welcome onScan={() => undefined} onLink={() => undefined} />);
    fireEvent.click(screen.getByText("Paste pairing link"));
    await settle();
    expect((screen.getByLabelText("Pairing link") as HTMLInputElement).value).toBe("");
  });

  it("says what a pairing link looks like when the pasted one is not", () => {
    const links: string[] = [];
    render(<Welcome onScan={() => undefined} onLink={(l) => links.push(l)} link="https://example.com/meeting" />);
    fireEvent.click(screen.getByText("Pair"));
    expect(links).toEqual([]);
    expect(screen.getByText(/That is not a pairing link/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: LINK } });
    expect(screen.queryByText(/That is not a pairing link/)).toBeNull();
    fireEvent.click(screen.getByText("Pair"));
    expect(links).toEqual([LINK]);
  });

  it("closes the paste panel on Cancel", () => {
    render(<Welcome onScan={() => undefined} onLink={() => undefined} link={LINK} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByLabelText("Pairing link")).toBeNull();
    expect(screen.getByText("Scan pairing code")).toBeTruthy();
  });

  it("says why it is back at the start", () => {
    render(<Welcome error="The relay no longer knows this phone. Pair it again." onScan={() => undefined} onLink={() => undefined} />);
    expect(screen.getByText("The relay no longer knows this phone. Pair it again.")).toBeTruthy();
  });
});

describe("pairing under way", () => {
  it("shows the step while the phone proves itself", () => {
    render(<Pairing step={{ kind: "status", text: "Contacting the relay" }} />);
    expect(screen.getByText("Pairing with your computer")).toBeTruthy();
    expect(screen.getByText("Contacting the relay")).toBeTruthy();
  });

  it("shows the code to compare while the owner decides", () => {
    render(<Pairing step={{ kind: "code", code: "482913" }} />);
    expect(screen.getByText("Allow this phone on your computer")).toBeTruthy();
    expect(screen.getByText("482 913")).toBeTruthy();
    expect(screen.getByLabelText("Code 4 8 2 9 1 3")).toBeTruthy();
    expect(screen.getByText(/choose Deny there/)).toBeTruthy();
    expect(screen.getByText("Waiting for your computer")).toBeTruthy();
  });

  it("draws the code the way Studio's approval card does", () => {
    render(<ApprovalCode code="050265" />);
    expect(screen.getByText("050 265")).toBeTruthy();
  });

  it("holds on Paired before the projects open", () => {
    render(<Paired />);
    expect(screen.getByText("Paired")).toBeTruthy();
    expect(screen.getByText("Opening your projects")).toBeTruthy();
  });
});

describe("pairing stopped", () => {
  const show = (failure: PairFailure) => {
    const seen: string[] = [];
    render(<PairFailed failure={failure} onScan={() => seen.push("scan")} onStart={() => seen.push("start")} onRetry={() => seen.push("retry")} />);
    return seen;
  };

  it.each([
    ["expired", "This code no longer works", /Each code works once, for ten minutes/],
    ["timeout", "Nobody allowed this phone in time", /waits 2 minutes for an answer/],
  ] as const)("a %s code is a state with a new code as the way on", (kind, title, lead) => {
    const seen = show({ kind, message: "relay words" });
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(lead)).toBeTruthy();
    expect(screen.queryByText("relay words")).toBeNull();
    fireEvent.click(screen.getByText("Scan a new code"));
    fireEvent.click(screen.getByText("Start over"));
    expect(seen).toEqual(["scan", "start"]);
  });

  it.each([
    ["denied", "Pairing did not finish", "The computer's owner denied this phone."],
    ["offline", "Your computer went offline", "It stopped answering while this phone was pairing."],
    ["bad-link", "This is not a pairing link", "The link was cut short, or it is not a UE-MCP Studio pairing code."],
    ["mismatch", "Pairing could not be checked", "The answer did not match the pairing code, so this phone does not trust it."],
    ["plan", "Remote control needs a plan", "Remote control needs a Pro or Studio plan on this account."],
    ["failed", "Pairing did not finish", "Remote control needs a Pro or Studio plan on this account."],
  ] as const)("%s is the error panel with what happened", (kind, head, text) => {
    const seen = show({ kind, message: "Remote control needs a Pro or Studio plan on this account." });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(head)).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByText("Scan a new code"));
    fireEvent.click(screen.getByText("Start over"));
    expect(seen).toEqual(["scan", "start"]);
  });

  it("offers Try again when the relay could not be reached", () => {
    const seen = show({ kind: "network", message: "Network request failed" });
    expect(screen.getByText("The relay could not be reached")).toBeTruthy();
    expect(screen.queryByText("Network request failed")).toBeNull();
    expect(screen.queryByText("Scan a new code")).toBeNull();
    fireEvent.click(screen.getByText("Try again"));
    expect(seen).toEqual(["retry"]);
  });
});

describe("why pairing stopped", () => {
  const real = globalThis.fetch;
  afterEach(() => void (globalThis.fetch = real));
  const answer = (status: number, body: unknown) => (globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch);

  it("names each refusal by what the phone can do about it", async () => {
    const { pair, PairError } = await import("../src/relay");
    const reason = (p: Promise<unknown>) => p.then(() => "paired", (e) => (e instanceof PairError ? e.kind : `not a PairError: ${e}`));
    expect(await reason(pair("https://example.com/meeting", () => undefined))).toBe("bad-link");
    answer(400, { error: "That code is used or expired. Make a new one on your computer.", code: "expired" });
    expect(await reason(pair(LINK, () => undefined))).toBe("expired");
    answer(403, { error: "Remote control needs a Pro or Studio plan on this account." });
    expect(await reason(pair(LINK, () => undefined))).toBe("plan");
    answer(400, { error: "Missing pairing code." });
    expect(await reason(pair(LINK, () => undefined))).toBe("failed");
    globalThis.fetch = vi.fn(async () => Promise.reject(new TypeError("Network request failed"))) as typeof fetch;
    expect(await reason(pair(LINK, () => undefined))).toBe("network");
  });

  it("reads the computer's answers while it decides", async () => {
    const { pairFailureOf } = await import("../src/relay");
    expect(pairFailureOf(403, "The computer denied this device.").kind).toBe("denied");
    expect(pairFailureOf(403, "Nobody allowed this device on the computer within 2 minutes. Make a new code.").kind).toBe("timeout");
    expect(pairFailureOf(403, "That pairing code is used, expired, or for another computer. Make a new one.").kind).toBe("expired");
    expect(pairFailureOf(403, "The computer no longer knows this request. Make a new code.").kind).toBe("expired");
    expect(pairFailureOf(503, "That project went offline. Make a new code once it is back.").kind).toBe("offline");
    expect(pairFailureOf(401, "Not paired.").kind).toBe("failed");
    expect(pairFailureOf(500, undefined).message).toBe("Pairing failed (500).");
  });
});

describe("scanner", () => {
  afterEach(() => {
    delete g.__qaCamera;
    delete g.__scanPicture;
    picked.next = { canceled: true, assets: null };
  });

  it("hands over the first code the camera reads, once", () => {
    const codes: string[] = [];
    g.__scan = LINK;
    render(<Scanner onCode={(c) => codes.push(c)} onCancel={() => undefined} />);
    fireEvent.click(screen.getByText("Camera preview"));
    fireEvent.click(screen.getByText("Camera preview"));
    expect(codes).toEqual([LINK]);
  });

  it("turns the torch on and off, and closes", () => {
    let closed = false;
    render(<Scanner onCode={() => undefined} onCancel={() => (closed = true)} />);
    const torch = screen.getByLabelText("Torch");
    expect(torch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(torch);
    expect(screen.getByLabelText("Torch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByLabelText("Close"));
    expect(closed).toBe(true);
  });

  it("reads a code from a picture, and says when a picture has none", async () => {
    const codes: string[] = [];
    picked.next = { canceled: false, assets: [{ uri: "file:///shot.png" }] };
    render(<Scanner onCode={(c) => codes.push(c)} onCancel={() => undefined} />);
    fireEvent.click(screen.getByText("Scan from a picture"));
    await settle();
    expect(screen.getByText(/No pairing code in that picture/)).toBeTruthy();
    g.__scanPicture = LINK;
    fireEvent.click(screen.getByText("Scan from a picture"));
    await settle();
    expect(codes).toEqual([LINK]);
  });

  it("waits for the permission to be known", () => {
    g.__qaCamera = null;
    render(<Scanner onCode={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText("Opening the camera")).toBeTruthy();
  });

  it("asks for the camera in place", () => {
    g.__qaCamera = { granted: false, canAskAgain: true, status: "undetermined" };
    render(<Scanner onCode={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText("Allow the camera")).toBeTruthy();
    expect(screen.getByText("Allow camera")).toBeTruthy();
    expect(screen.getByText("Scan from a picture")).toBeTruthy();
  });

  it("sends a camera refused for good to the settings", () => {
    // react-native-web has no system settings to open.
    const open = vi.fn(async () => undefined);
    (Linking as { openSettings?: () => Promise<void> }).openSettings = open;
    let back = false;
    g.__qaCamera = { granted: false, canAskAgain: false, status: "denied" };
    render(<Scanner onCode={() => undefined} onCancel={() => (back = true)} />);
    expect(screen.getByText("The camera is off for Studio")).toBeTruthy();
    fireEvent.click(screen.getByText("Open settings"));
    expect(open).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Back"));
    expect(back).toBe(true);
    delete (Linking as { openSettings?: unknown }).openSettings;
  });
});

describe("Projects and Devices", () => {
  beforeEach(() => {
    store.clear();
    relay.trusted.mockResolvedValue({ keyA: { pairedAt: "2026-11-01T00:00:00Z" } });
    relay.account.mockResolvedValue({
      devices: [
        { id: "d1", name: "Lyra", online: true, computerKey: "keyA", lastSeen: "2026-11-04T12:00:00Z" },
        { id: "d2", name: "Other", online: true, computerKey: "keyB", lastSeen: "2026-11-04T12:00:00Z" },
        { id: "d3", name: "Asleep", online: false, computerKey: "keyA", lastSeen: new Date(Date.now() - 3 * 3600_000).toISOString() },
      ],
      viewers: [
        { id: "v1", label: "Android (Studio app)", createdAt: "2026-11-01T00:00:00Z", current: true },
        { id: "v2", label: "Windows (Edge)", createdAt: "2026-10-01T00:00:00Z", current: false },
      ],
    });
  });

  it("opens a paired project and explains one on another computer", async () => {
    const opened: string[] = [];
    render(<Projects onOpen={(d) => opened.push(d.id)} onPair={() => undefined} onSettings={() => undefined} onUnpaired={() => undefined} />);
    await settle();
    expect(screen.getByText("On a computer this phone has not paired with. Scan its pairing code to open it here.")).toBeTruthy();
    expect(screen.getByText("Offline, last seen 3 h ago")).toBeTruthy();
    fireEvent.click(screen.getByText("Lyra"));
    fireEvent.click(screen.getByText("Other"));
    expect(opened).toEqual(["d1"]);
  });

  it("marks the project opened last", async () => {
    store.set("selected", JSON.stringify({ id: "d1" }));
    render(<Projects onOpen={() => undefined} onPair={() => undefined} onSettings={() => undefined} onUnpaired={() => undefined} />);
    await settle();
    expect(screen.getByText("Opened last")).toBeTruthy();
  });

  it("says when no project has connected, and when the relay fails", async () => {
    relay.account.mockResolvedValueOnce({ devices: [], viewers: [] });
    const first = render(<Projects onOpen={() => undefined} onPair={() => undefined} onSettings={() => undefined} onUnpaired={() => undefined} />);
    expect(screen.getByText("Loading your projects")).toBeTruthy();
    await settle();
    expect(screen.getByText("No projects yet")).toBeTruthy();
    first.unmount();
    relay.account.mockRejectedValueOnce(new Error("The relay answered 503."));
    render(<Projects onOpen={() => undefined} onPair={() => undefined} onSettings={() => undefined} onUnpaired={() => undefined} />);
    await settle();
    expect(screen.getByText("The relay answered 503.")).toBeTruthy();
  });

  it("goes to Devices and to pairing", async () => {
    const seen: string[] = [];
    render(<Projects onOpen={() => undefined} onPair={() => seen.push("pair")} onSettings={() => seen.push("devices")} onUnpaired={() => undefined} />);
    await settle();
    fireEvent.click(screen.getByLabelText("Paired devices"));
    fireEvent.click(screen.getByText("Pair another computer"));
    expect(seen).toEqual(["devices", "pair"]);
  });

  it("removes another browser after confirming", async () => {
    const spy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    relay.removeViewer.mockResolvedValue(undefined);
    render(<Settings onBack={() => undefined} onRemoved={() => undefined} />);
    await settle();
    expect(screen.getByText("Android (Studio app)")).toBeTruthy();
    expect(screen.getByText(/^This phone\. Paired/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove Windows (Edge)"));
    const buttons = spy.mock.calls.at(-1)?.[2] ?? [];
    buttons.find((b) => b.text === "Remove")?.onPress?.();
    expect(relay.removeViewer).toHaveBeenCalledWith(expect.objectContaining({ id: "v2" }));
    expect(screen.getByText("Lyra, Asleep")).toBeTruthy();
    spy.mockRestore();
  });

  it("forgets a trusted computer after confirming, and opens About", async () => {
    const spy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    relay.forgetComputer.mockResolvedValue(undefined);
    let about = false;
    render(<Settings onBack={() => undefined} onRemoved={() => undefined} onAbout={() => (about = true)} />);
    await settle();
    fireEvent.click(screen.getByLabelText("Forget Lyra, Asleep"));
    spy.mock.calls.at(-1)?.[2]?.find((b) => b.text === "Forget")?.onPress?.();
    expect(relay.forgetComputer).toHaveBeenCalledWith("keyA");
    fireEvent.click(screen.getByText("About"));
    expect(about).toBe(true);
    spy.mockRestore();
  });

  it("says how long ago an offline project was seen", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(lastSeen("2026-11-04T11:59:40Z", now)).toBe("Offline, last seen just now");
    expect(lastSeen("2026-11-04T11:15:00Z", now)).toBe("Offline, last seen 45 min ago");
    expect(lastSeen("2026-11-03T11:00:00Z", now)).toBe("Offline, last seen 1 day ago");
    expect(lastSeen("2026-10-30T11:00:00Z", now)).toBe("Offline, last seen 5 days ago");
  });
});

describe("About", () => {
  const health = (studio: string): Transport => async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: (async function* () {
      yield new TextEncoder().encode(JSON.stringify({ version: "1.4.12", extensions: [{ name: "studio", version: studio }] }));
    })(),
  });
  beforeEach(() => store.clear());

  it("says the computer's Studio fits this app", async () => {
    store.set("selected", JSON.stringify({ id: "d1", name: "Lyra", online: true, computerKey: "k", lastSeen: "" }));
    render(<About onBack={() => undefined} transport={() => health("0.1.25-beta.40")} />);
    await settle();
    await settle();
    expect(screen.getByText("Lyra")).toBeTruthy();
    expect(screen.getByText("0.1.25-beta.40")).toBeTruthy();
    expect(screen.getByText("This app and the Studio on that computer work together.")).toBeTruthy();
  });

  it("says what to update when it is too old", async () => {
    store.set("selected", JSON.stringify({ id: "d1", name: "Lyra", online: true, computerKey: "k", lastSeen: "" }));
    render(<About onBack={() => undefined} transport={() => health("0.1.25-beta.12")} />);
    await settle();
    await settle();
    expect(screen.getByText(/this app needs 0\.1\.25-beta\.30 or newer/)).toBeTruthy();
  });

  it("says when the computer does not answer, and when no project was opened", async () => {
    store.set("selected", JSON.stringify({ id: "d1", name: "Lyra", online: true, computerKey: "k", lastSeen: "" }));
    const first = render(<About onBack={() => undefined} transport={() => async () => Promise.reject(new Error("offline"))} />);
    expect(screen.getByText("Asking the computer")).toBeTruthy();
    await settle();
    await settle();
    expect(screen.getByText(/did not answer/)).toBeTruthy();
    first.unmount();
    store.clear();
    render(<About onBack={() => undefined} />);
    await settle();
    expect(screen.getByText("Open a project to see what its computer runs.")).toBeTruthy();
  });
});

describe("phone-only banners and prompts", () => {
  afterEach(() => void delete g.__qaOffline);

  it("says when this phone is offline", () => {
    const { container } = render(<OfflineBanner />);
    expect(container.textContent).toBe("");
    g.__qaOffline = true;
    render(<OfflineBanner />);
    expect(screen.getByText("This phone is offline. Studio reconnects when it is back.")).toBeTruthy();
  });

  it("offers the fingerprint after a typed PIN", () => {
    const seen: string[] = [];
    render(<RememberOffer onYes={() => seen.push("yes")} onNo={() => seen.push("no")} />);
    expect(screen.getByText("Unlock with your fingerprint?")).toBeTruthy();
    fireEvent.click(screen.getByText("Use fingerprint next time"));
    fireEvent.click(screen.getByText("Not now"));
    expect(seen).toEqual(["yes", "no"]);
  });
});
