// @vitest-environment jsdom
/**
 * The paired browser's side of the PIN lock: a request the computer locked
 * waits for the PIN and goes again; one the owner declines comes back with its
 * 423; the computer stays the one that decides.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelPrompt, installLockGuard, lockView, refreshLock, resetLockForTests, unlockWith, LOCK_URL } from "./remote-lock";

interface Fake {
  locked: boolean;
  sensitiveOpen: boolean;
  pin: string;
  calls: string[];
}

let fake: Fake;
let realFetch: typeof fetch;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const state = () => ({ whole: true, sensitive: true, locked: fake.locked, sensitiveOpen: fake.sensitiveOpen, idleMinutes: 15 });

/** The computer, as the page reaches it through the relay. */
async function computer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  fake.calls.push(`${method} ${url}`);
  if (url === LOCK_URL) return json(200, state());
  if (url === `${LOCK_URL}/unlock`) {
    const pin = (JSON.parse(String(init?.body)) as { pin: string }).pin;
    if (pin === "0000") return json(403, { error: "Wrong PIN 10 times in a row. This device was removed; pair it again from the computer.", unpaired: true, remaining: 0 });
    if (pin !== fake.pin) return json(401, { error: "Wrong PIN.", remaining: 7, retryAfterMs: 2000 });
    fake.locked = false;
    fake.sensitiveOpen = true;
    return json(200, state());
  }
  if (fake.locked) return json(423, { error: "Locked. Enter your PIN.", code: "locked" });
  if (method === "POST" && url.includes("/approvals/") && !fake.sensitiveOpen) return json(423, { error: "Enter your PIN to do this.", code: "pin-required" });
  return json(200, { ok: true, url });
}

beforeEach(() => {
  resetLockForTests();
  fake = { locked: false, sensitiveOpen: false, pin: "4821", calls: [] };
  realFetch = window.fetch;
  window.fetch = computer as typeof fetch;
  installLockGuard(window);
});

afterEach(() => {
  window.fetch = realFetch;
  resetLockForTests();
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("a paired browser's page under the PIN lock", () => {
  it("a locked client: requests wait behind the lock screen and go again once the PIN is in", async () => {
    fake.locked = true;
    const pending = window.fetch("/v1/ext/studio/sessions");
    await until(() => lockView().screen);
    expect((await unlockWith("1234")).ok).toBe(false);
    expect(lockView().screen).toBe(true);
    expect(lockView().state?.remaining).toBe(7);
    expect(await unlockWith("4821")).toEqual({ ok: true });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(lockView().screen).toBe(false);
    expect(fake.calls.filter((c) => c === "GET /v1/ext/studio/sessions")).toHaveLength(2);
  });

  it("a sensitive action: the PIN sheet, then the action goes ahead with its body", async () => {
    const pending = window.fetch("/v1/ext/studio/sessions/s1/approvals/a1", { method: "POST", body: JSON.stringify({ allow: true }) });
    await until(() => lockView().prompt);
    await unlockWith("4821");
    const res = await pending;
    expect(res.status).toBe(200);
    expect(lockView().prompt).toBe(false);
  });

  it("declining the sheet leaves the action undone: its 423 comes back", async () => {
    const pending = window.fetch("/v1/ext/studio/sessions/s1/approvals/a1", { method: "POST", body: "{}" });
    await until(() => lockView().prompt);
    cancelPrompt();
    const res = await pending;
    expect(res.status).toBe(423);
    expect(fake.calls.filter((c) => c.includes("/approvals/"))).toHaveLength(1);
  });

  it("a request given up while it waits ends as aborted", async () => {
    fake.locked = true;
    const ctl = new AbortController();
    const pending = window.fetch("/v1/events", { signal: ctl.signal });
    await until(() => lockView().screen);
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("the tenth wrong PIN: the screen says the device was removed", async () => {
    fake.locked = true;
    await refreshLock();
    expect(lockView().screen).toBe(true);
    expect(await unlockWith("0000")).toMatchObject({ ok: false, removed: true });
    expect(lockView().removed).toBe(true);
  });

  it("the lock's own routes and other answers pass straight through", async () => {
    expect((await window.fetch("/v1/ext/studio/sessions")).status).toBe(200);
    expect(lockView().screen).toBe(false);
    expect(lockView().prompt).toBe(false);
  });
});
