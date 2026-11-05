/**
 * Build 11 after a reinstall: Android's backup brought back the old pairings
 * while the phone's key was new, so the computer answered "This device is not
 * paired with that computer" to everything and the app had no way back to
 * pairing. Now a pairing without its key is dropped at startup, the computer's
 * "not paired" answer drops that computer and opens pairing, and the drawer
 * always offers the projects list and Pair again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import { store } from "./mocks/secure-store";
import { settle } from "./helpers";
import { ThemeProvider } from "../src/ui";
import { dropPairingsWithoutKey, NotPairedError, RelayError, trusted, unpairedAnswer, watchUnpaired } from "../src/relay";

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});
const DEVICE = { id: "d", name: "Vale on NIMBA1", online: true, computerKey: "k", lastSeen: "" };

beforeEach(() => store.clear());

describe("pairings without their key", () => {
  it("are dropped at startup, so the app opens on pairing", async () => {
    store.set("trusted", JSON.stringify({ k: { pairedAt: "2026-11-04T00:00:00Z" } }));
    store.set("selected", JSON.stringify(DEVICE));
    expect(await dropPairingsWithoutKey()).toBe(true);
    expect(await trusted()).toEqual({});
    expect(store.has("selected")).toBe(false);
  });

  it("are kept while the key is there", async () => {
    store.set("phone", JSON.stringify({ jwk: {}, publicKey: "p" }));
    store.set("trusted", JSON.stringify({ k: { pairedAt: "2026-11-04T00:00:00Z" } }));
    expect(await dropPairingsWithoutKey()).toBe(false);
    expect(Object.keys(await trusted())).toEqual(["k"]);
  });

  it("change nothing on a fresh install", async () => {
    expect(await dropPairingsWithoutKey()).toBe(false);
  });
});

describe("the computer's not-paired answer", () => {
  it("is told apart from other refusals", () => {
    expect(unpairedAnswer(new RelayError(403, "This device is not paired with that computer. Pair it again with a new code."))).toMatch(/not paired/);
    expect(unpairedAnswer(new RelayError(403, "The request did not decrypt."))).toMatch(/decrypt/);
    expect(unpairedAnswer(new NotPairedError("This phone is not paired with that computer."))).toMatch(/not paired/);
    expect(unpairedAnswer(new RelayError(403, "Replayed or stale request. Check this device's clock."))).toBeNull();
    expect(unpairedAnswer(new RelayError(503, "That project is offline."))).toBeNull();
  });

  it("is reported once, and the request still fails", async () => {
    const on = vi.fn();
    const t = watchUnpaired(async () => {
      throw new RelayError(403, "This device is not paired with that computer. Pair it again with a new code.");
    }, on);
    await expect(t("GET", "/v1/health")).rejects.toThrow(/not paired/);
    await expect(t("GET", "/v1/health")).rejects.toThrow(/not paired/);
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("ends the project in the shell", async () => {
    const { AppShell } = await import("../src/AppShell");
    const t: Transport = async () => {
      throw new RelayError(403, "This device is not paired with that computer. Pair it again with a new code.");
    };
    const onUnpaired = vi.fn();
    render(
      <ThemeProvider name="ue-mcp">
        <AppShell device={DEVICE} transport={t} onBack={() => undefined} onUnpaired={onUnpaired} />
      </ThemeProvider>,
    );
    await settle();
    expect(onUnpaired).toHaveBeenCalledWith(expect.stringMatching(/not paired/));
  });
});

describe("the drawer's ways out", () => {
  it("offers the projects list and Pair again whatever the project is doing", async () => {
    const { AppShell } = await import("../src/AppShell");
    const t: Transport = async (method, path) => {
      if (path === "/v1/ext/studio/lock") return json(200, { whole: false, locked: false });
      if (path === "/v1/events") return { status: 200, headers: {}, body: (async function* () { await new Promise(() => undefined); })() };
      return json(method === "GET" ? 404 : 409, { error: "no" });
    };
    const onBack = vi.fn();
    const onPair = vi.fn();
    render(
      <ThemeProvider name="ue-mcp">
        <AppShell device={DEVICE} transport={t} onBack={onBack} onPair={onPair} onUnpaired={() => undefined} />
      </ThemeProvider>,
    );
    await settle();
    fireEvent.click(screen.getByLabelText("Pair this phone with a computer again"));
    expect(onPair).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("All projects on your paired computers"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
