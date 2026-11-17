// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AccountView } from "./Account";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const usage = (billableTokens: number) => ({
  login: "dev", plan: { name: "Pro" }, status: "active", periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-12-01T00:00:00Z",
  quota: 1000, billableTokens, remaining: Math.max(0, 1000 - billableTokens), used: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
});
const serve = (u: ReturnType<typeof usage>) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ signedIn: true, usage: u, manageUrl: "https://billing.example/portal" }), { status: 200 })));

describe("the account's usage", () => {
  it("offers a way on when the period's tokens are used up", async () => {
    serve(usage(1000));
    render(<AccountView />);
    expect(await screen.findByText(/tokens are used up/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Manage plan" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/own API key or another sign-in keeps working/)).toBeTruthy();
  });

  it("says nothing of the kind while tokens remain", async () => {
    serve(usage(10));
    render(<AccountView />);
    await screen.findByText(/left/);
    expect(screen.queryByText(/used up/)).toBeNull();
  });
});
