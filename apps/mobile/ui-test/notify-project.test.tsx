/**
 * A notification carries its project and opens it from the app's Projects
 * home: a tap from another project switches to that one on its session, and a
 * tap that opens the app wins over startup's own choice of the last project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import { store } from "./mocks/secure-store";
import { settle } from "./helpers";

const fixture = vi.hoisted(() => ({ transport: null as Transport | null, delays: [] as number[] }));
vi.mock("../src/relay", async (original) => {
  const real = await original<typeof import("../src/relay")>();
  // Each call to the relay's list answers after the next delay in fixture.delays (none: at once).
  return { ...real, transportFor: () => fixture.transport!, account: () => new Promise((done) => setTimeout(() => done({ devices: [VALE, LYRA], viewers: [] }), fixture.delays.shift() ?? 0)) };
});

const VALE = { id: "dev1", name: "Vale on NIMBA1", online: true, computerKey: "k1", lastSeen: "2026-11-04T12:00:00Z" };
const LYRA = { id: "dev2", name: "Lyra on NIMBA1", online: true, computerKey: "k1", lastSeen: "2026-11-04T12:00:00Z" };
const SESSIONS = [{ id: "s1", title: "Door that opens", status: "idle", createdAt: "2026-11-04T12:00:00Z", updatedAt: "2026-11-04T12:05:00Z", archived: false, awaiting: 0, agents: { total: 0, running: 0 } }];

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});

const daemon: Transport = async (method, path) => {
  if (path === "/v1/events") return { status: 200, headers: {}, body: (async function* () { await new Promise(() => undefined); })() };
  if (path === "/v1/health") return json(200, { version: "1", startedAt: "a", lastEventId: 0, editors: [] });
  if (path === "/v1/ext/studio/lock") return json(200, { whole: false, sensitive: false, locked: false, sensitiveOpen: true });
  if (path === "/v1/ext/studio/sessions") return json(200, { sessions: SESSIONS });
  if (path.startsWith("/v1/ext/studio/sessions/s1")) return json(200, { ...SESSIONS[0], transcript: [{ kind: "user", text: "Make the door open", at: "2026-11-04T12:00:00Z" }], draft: "" });
  if (path === "/v1/ext/studio/settings") return json(200, { theme: "ue-mcp", route: "key", provider: "anthropic", model: "m", effort: "high" });
  return json(method === "GET" ? 404 : 409, { error: "no" });
};

const tap = (d: { deviceId: string; kind: string; sessionId?: string }) => (globalThis as unknown as { __studioNotifyTap: (d: unknown) => void }).__studioNotifyTap(d);

/** The open project's name, from the drawer's head. */
async function openProjectName(): Promise<string | null> {
  fireEvent.click(screen.getByLabelText("Open navigation"));
  await settle();
  return [VALE.name, LYRA.name].find((n) => screen.queryAllByText(n).length > 0) ?? null;
}

beforeEach(() => {
  store.clear();
  store.set("phone", JSON.stringify({ jwk: {}, publicKey: "phone" }));
  store.set("trusted", JSON.stringify({ k1: { pairedAt: "2026-11-04T12:00:00Z" } }));
  store.set("selected", JSON.stringify(VALE));
  fixture.transport = daemon;
  fixture.delays = [];
});

describe("a notification's project", { timeout: 30_000 }, () => {
  it("switches from the open project to the notified one, on its session", async () => {
    const { default: App } = await import("../App");
    render(<App />);
    for (let i = 0; i < 6; i++) await settle();
    expect(await openProjectName()).toBe(VALE.name);
    tap({ deviceId: LYRA.id, kind: "turn.finished", sessionId: "s1" });
    for (let i = 0; i < 6; i++) await settle();
    expect(screen.getByText("Make the door open")).toBeTruthy();
    expect(await openProjectName()).toBe(LYRA.name);
  });

  it("wins over startup's last project when it opens the app", async () => {
    // The tap reads the relay's list first and gets it at once; startup's read answers later and must not take over.
    fixture.delays = [0, 300];
    const { default: App } = await import("../App");
    render(<App />);
    tap({ deviceId: LYRA.id, kind: "turn.finished", sessionId: "s1" });
    await new Promise((done) => setTimeout(done, 500));
    for (let i = 0; i < 8; i++) await settle();
    expect(await openProjectName()).toBe(LYRA.name);
  });

  it("opens Projects when its project is not one this phone knows", async () => {
    const { default: App } = await import("../App");
    render(<App />);
    for (let i = 0; i < 6; i++) await settle();
    tap({ deviceId: "gone", kind: "turn.finished" });
    for (let i = 0; i < 6; i++) await settle();
    expect(await screen.findByText("Choose the project to open in Studio.")).toBeTruthy();
  });
});
