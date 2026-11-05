import { describe, expect, it } from "vitest";
import {
  BILLING_PLANS,
  PAID_PLAN_IDS,
  PRO_PLAN_OFFERED,
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

  it("names no Pro offer while Pro is not offered", () => {
    expect(PRO_PLAN_OFFERED).toBe(false);
    for (const s of [REMOTE_PLANS, REMOTE_NO_PLAN, REMOTE_PLAN_NOTE, REMOTE_COMMAND_REPLY]) expect(s).not.toMatch(/\bPro\b/);
    expect(REMOTE_PLAN_NOTE).toBe("Needs the Remote plan: $5 a month or $50 a year, before tax.");
  });
});
