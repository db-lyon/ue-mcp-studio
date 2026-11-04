/**
 * A computer whose remote lock is on, met right after pairing: the keypad must
 * cover the project before anything else, never the lock's error text.
 */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import { settle } from "./helpers";

const state = { locked: true };
const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});
const computer: Transport = async (_method, path) => {
  if (path === "/v1/ext/studio/lock") return json(200, { whole: true, sensitive: true, locked: state.locked, sensitiveOpen: false, idleMinutes: 10, pinLength: 4 });
  if (path === "/v1/health") return json(200, { version: "1.4.13", startedAt: "s", lastEventId: 0 });
  if (state.locked) return json(423, { error: "Locked. Enter your PIN.", code: "locked" });
  return json(200, { sessions: [] });
};

vi.mock("../src/relay", async (orig) => ({ ...(await orig<object>()), transportFor: () => computer }));
const { ProjectScreen } = await import("../src/screens/Project");

describe("a locked computer after pairing", () => {
  it("shows the native keypad, not the lock's error", async () => {
    render(<ProjectScreen device={{ id: "d1", name: "Lyra", online: true, computerKey: "k", lastSeen: "" }} onBack={() => undefined} onUnpaired={() => undefined} />);
    await settle();
    await settle();
    expect(screen.getByText("Studio is locked")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.queryByText("Locked. Enter your PIN.")).toBeNull();
  });
});
