import { describe, expect, it } from "vitest";
import {
  BILLING_PLANS,
  PAID_PLAN_IDS,
  PRO_PLAN_OFFERED,
  REMOTE_INTERVAL_NAMES,
  REMOTE_PLAN_OFFERED,
  STUDIO_PLAN_AVAILABLE,
  remoteCommand,
  remoteSurface,
  REMOTE_COMMAND_REPLY,
  REMOTE_NO_PLAN,
  REMOTE_PLAN_NOTE,
  REMOTE_PLANS,
  hasPaidPlan,
} from "../src/index.js";

const usage = (id: string) => ({ plan: { id, name: id, models: [] }, status: "active" as const, periodEnd: "2027-01-01T00:00:00Z" });
const NOW = new Date("2026-11-05T00:00:00Z");

describe("plans", () => {
  it("gives remote control to Remote and Pro, and to nothing else", () => {
    expect(PAID_PLAN_IDS).toEqual(["remote", "pro"]);
    expect(hasPaidPlan(usage("remote"), NOW)).toBe(true);
    expect(hasPaidPlan(usage("pro"), NOW)).toBe(true);
    for (const id of ["free", "studio", ""]) expect(hasPaidPlan(usage(id), NOW)).toBe(false);
  });

  it("sells Remote and Pro, the gateway's checkout plans", () => {
    expect(BILLING_PLANS).toEqual(["remote", "pro"]);
  });

  it("offers Remote to every account while Pro and the Studio model plan stay hidden", () => {
    expect(REMOTE_PLAN_OFFERED).toBe(true);
    expect(PRO_PLAN_OFFERED).toBe(false);
    expect(STUDIO_PLAN_AVAILABLE).toBe(false);
  });

  it("shows remote control in three states with the shipped flag: sign-in, Upgrade, working", () => {
    expect(remoteSurface(REMOTE_PLAN_OFFERED, false, false)).toBe("signin");
    expect(remoteSurface(REMOTE_PLAN_OFFERED, false, true)).toBe("upsell");
    expect(remoteSurface(REMOTE_PLAN_OFFERED, true, true)).toBe("working");
    expect(remoteCommand(REMOTE_PLAN_OFFERED, false, false)).toBe("open");
    expect(remoteCommand(REMOTE_PLAN_OFFERED, false, true)).toBe("upgrade");
    expect(remoteCommand(REMOTE_PLAN_OFFERED, true, true)).toBe("open");
  });

  it("prices the billing choice as the gateway sells Remote", () => {
    expect(REMOTE_INTERVAL_NAMES).toEqual({ month: "$5/month", year: "$50/year" });
  });

  it("names no Pro offer while Pro is not offered", () => {
    expect(PRO_PLAN_OFFERED).toBe(false);
    for (const s of [REMOTE_PLANS, REMOTE_NO_PLAN, REMOTE_PLAN_NOTE, REMOTE_COMMAND_REPLY]) expect(s).not.toMatch(/\bPro\b/);
    expect(REMOTE_PLAN_NOTE).toBe("Needs the Remote plan: $5 a month or $50 a year, before tax.");
  });
});
