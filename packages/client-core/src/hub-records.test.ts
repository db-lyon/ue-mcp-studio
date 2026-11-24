import { describe, expect, it } from "vitest";
import type { HubOverview } from "@ue-mcp-studio/shared";
import { classifyLink, remarkReplyLinks, type MdNode } from "./links.js";
import { hubAddressRoute, hubRecordIndex, hubRecordLocation, hubRecordRoute, hubRouteScript, playtestRecordIndex } from "./hub-records.js";

const run = (runId: string, target: string) => ({ runId, kind: "script" as const, target, name: target.split("/").pop()!, outcome: "passed" as const, startedAt: "2026-11-22T10:00:00Z", source: "person" as const });

const overview = {
  goals: [{ goal: { id: "alpha-k3", kind: "milestone", title: "Alpha" } }, { goal: { id: "door-opens-x7", kind: "goal", title: "Door opens" } }],
  checks: [
    { id: "script:/Game/Tests/PT_Jump", check: { kind: "script", target: "/Game/Tests/PT_Jump" }, last: run("run-jump-2", "/Game/Tests/PT_Jump") },
    { id: "script:/Game/QA/PT_Door", check: { kind: "script", target: "/Game/QA/PT_Door" }, renamedFrom: "/Game/Tests/PT_Door", last: null },
  ],
  recent: [run("run-swim-1", "/Game/Tests/PT_Swim")],
} as unknown as Pick<HubOverview, "goals" | "checks" | "recent">;
const index = hubRecordIndex(overview);

describe("hubRecordRoute", () => {
  it("opens a playtest script's object path as its playtest, whatever the case or object name", () => {
    expect(hubRecordRoute("/Game/Tests/PT_Jump.PT_Jump", index)).toEqual({ screen: "check", checkId: "script:/Game/Tests/PT_Jump" });
    expect(hubRecordRoute("/Game/Tests/PT_Jump", index)).toEqual({ screen: "check", checkId: "script:/Game/Tests/PT_Jump" });
    expect(hubRecordRoute("/game/tests/pt_jump.PT_Jump", index)).toEqual({ screen: "check", checkId: "script:/Game/Tests/PT_Jump" });
  });

  it("follows a script that moved from the path goals still name", () => {
    expect(hubRecordRoute("/Game/Tests/PT_Door.PT_Door", index)).toEqual({ screen: "check", checkId: "script:/Game/QA/PT_Door" });
  });

  it("names goals, milestones, runs and playtests by id", () => {
    expect(hubRecordRoute("door-opens-x7", index)).toEqual({ screen: "goal", goalId: "door-opens-x7" });
    expect(hubRecordRoute("alpha-k3", index)).toEqual({ screen: "goal", goalId: "alpha-k3" });
    expect(hubRecordRoute("run-jump-2", index)).toEqual({ screen: "run", runId: "run-jump-2" });
    expect(hubRecordRoute("run-swim-1", index)).toEqual({ screen: "run", runId: "run-swim-1" });
    expect(hubRecordRoute("script:/Game/Tests/PT_Jump", index)).toEqual({ screen: "check", checkId: "script:/Game/Tests/PT_Jump" });
  });

  it("leaves other assets, unknown ids and files to their own links", () => {
    expect(hubRecordRoute("/Game/Props/BP_Door.BP_Door", index)).toBeNull();
    expect(hubRecordRoute("no-such-goal", index)).toBeNull();
    expect(hubRecordRoute("Source/Door.cpp", index)).toBeNull();
    expect(hubRecordRoute("", index)).toBeNull();
  });

  it("opens a hub address even before the hub's records are known, and nothing else then", () => {
    expect(hubRecordRoute("#/playtests/goals/door-opens-x7", null)).toEqual({ screen: "goal", goalId: "door-opens-x7" });
    expect(hubRecordRoute("#/playtests/runs/run-9", null)).toEqual({ screen: "run", runId: "run-9" });
    expect(hubRecordRoute("#/playtests", null)).toEqual({ screen: "overview" });
    expect(hubRecordRoute("/Game/Tests/PT_Jump.PT_Jump", null)).toBeNull();
    expect(hubRecordRoute("door-opens-x7", null)).toBeNull();
  });
});

describe("hub addresses", () => {
  it("reads #/playtests addresses, and only those", () => {
    expect(hubAddressRoute("#/playtests/checks/script%3A%2FGame%2FTests%2FPT_Jump")).toEqual({ screen: "check", checkId: "script:/Game/Tests/PT_Jump" });
    expect(hubAddressRoute("#/playtests/nonsense")).toEqual({ screen: "overview" });
    expect(hubAddressRoute("#/chat/abc")).toBeNull();
    expect(hubAddressRoute("playtests/goals/x")).toBeNull();
  });

  it("gives the location that opens a route on the Playtests tab", () => {
    expect(hubRecordLocation({ screen: "goal", goalId: "a b" })).toEqual({ tab: "Playtests", sub: "goals/a%20b" });
    expect(hubRecordLocation({ screen: "overview" })).toEqual({ tab: "Playtests", sub: null });
  });

  it("classifies a markdown link to a hub address as a hub link, kept as a span with its text", () => {
    expect(classifyLink("#/playtests/goals/door-opens-x7")).toEqual({ kind: "hub", route: { screen: "goal", goalId: "door-opens-x7" } });
    const tree: MdNode = { type: "root", children: [{ type: "paragraph", children: [{ type: "link", url: "#/playtests/runs/run-9", children: [{ type: "text", value: "the run" }] }] }] };
    remarkReplyLinks()(tree);
    const span = tree.children![0].children![0];
    expect(span.type).toBe("hubLink");
    expect(span.data?.hProperties).toEqual({ "data-hub-address": "#/playtests/runs/run-9" });
    expect(span.children).toEqual([{ type: "text", value: "the run" }]);
  });
});

describe("the phone's playtest index", () => {
  it("knows the playtest list's scripts, not deleted ones", () => {
    const i = playtestRecordIndex([{ script: "/Game/Tests/PT_Jump" }, { script: "/Game/Tests/PT_Gone", deleted: true }]);
    expect(hubRecordRoute("/Game/Tests/PT_Jump.PT_Jump", i)).toEqual({ screen: "check", checkId: "script:/Game/Tests/PT_Jump" });
    expect(hubRecordRoute("/Game/Tests/PT_Gone", i)).toBeNull();
  });

  it("finds the script a route shows", () => {
    expect(hubRouteScript({ screen: "check", checkId: "script:/Game/Tests/PT_Jump" })).toBe("/Game/Tests/PT_Jump");
    expect(hubRouteScript({ screen: "goal", goalId: "g" })).toBeNull();
  });
});
