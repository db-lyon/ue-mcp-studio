/**
 * Performers' pure parts: the feature, a track's performer and its text
 * form, typed names, the picker's groups, and performer findings placed on
 * the instance they are about.
 */
import { describe, expect, it, vi } from "vitest";
import type { ArrangementFinding, PerformersView, SetAnswer } from "@ue-mcp-studio/shared";
import {
  PERFORMER_COPY,
  SET_OPS,
  arrangementFindings,
  fallbackPlayers,
  parsePerformer,
  performerGroups,
  performerId,
  performerOfTrack,
  performerText,
  performersOn,
  placePerformerFindings,
  resolvePerformer,
  runTracksOf,
  setApi,
  takesLane,
} from "./index.js";

const track = (id: string, order: number, instances: string[], extra: Record<string, unknown> = {}) => ({
  id, title: id, order, player: 0, mute: false, solo: false, status: "not_started",
  arrangement: { rate: 60, instances: instances.map((i) => ({ id: i, kind: "clip", target: `/Game/C/${i}`, start: 0 })) },
  layout: instances.map((i) => ({ id: i, kind: "clip", target: `/Game/C/${i}`, name: i, start: 0, end: 60, length: 60, known: true })),
  ...extra,
});
const SET = {
  text: "",
  findings: [] as ArrangementFinding[],
  tracks: [track("hero", 0, ["i1"]), track("guard", 1, ["i1", "i2"], { performer: { kind: "actor", actor: "Guard 2" } }), track("cam", 2, ["i3"], { mute: true })],
  scenes: [{ id: "door", title: "Door", order: 0, status: "not_started", tracks: ["hero", "guard"] }],
} as unknown as SetAnswer;

describe("performers", () => {
  it("reads the feature from health", () => {
    expect(performersOn({ features: ["hub.arrangement", "hub.performers"] })).toBe(true);
    expect(performersOn({ features: ["hub.arrangement"] })).toBe(false);
    expect(performersOn(null)).toBe(false);
  });

  it("reads a track's performer, and a daemon's that predates performers from its player", () => {
    expect(performerOfTrack({ player: 2 })).toEqual({ kind: "player", client: 2 });
    expect(performerOfTrack({ player: 0, performer: { kind: "actor", actor: "Guard" } })).toEqual({ kind: "actor", actor: "Guard" });
  });

  it("writes the text form the set's op lines take, quoting names with spaces", () => {
    expect(performerText({ kind: "player", client: 1 })).toBe("player:1");
    expect(performerText({ kind: "actor", actor: "BP_Guard_C_2" })).toBe("actor:BP_Guard_C_2");
    expect(performerText({ kind: "actor", actor: 'Guard "2"' })).toBe('actor:"Guard \\"2\\""');
    expect(SET_OPS.trackPerformer("guard", { kind: "actor", actor: "Guard 2" })).toBe('track performer guard actor:"Guard 2"');
    expect(SET_OPS.trackAddFor("Guard", { kind: "actor", actor: "Guard 2" })).toBe('track add "Guard" performer=actor:"Guard 2"');
  });

  it("asks the daemon for the performers of the arrangement shown", async () => {
    const req = vi.fn().mockResolvedValue({});
    await setApi(req).performers("boss rush");
    await setApi(req).performers();
    expect(req.mock.calls).toEqual([["GET", "/v1/hub/performers?arrangement=boss%20rush"], ["GET", "/v1/hub/performers"]]);
  });

  it("reads a typed performer: a number or player:N, actor:<name> or any name, a candidate's label", () => {
    expect(parsePerformer("2")).toEqual({ kind: "player", client: 2 });
    expect(parsePerformer("player:3")).toEqual({ kind: "player", client: 3 });
    expect(parsePerformer('actor:"Gate 1"')).toEqual({ kind: "actor", actor: "Gate 1" });
    expect(parsePerformer("BP_Wolf")).toEqual({ kind: "actor", actor: "BP_Wolf" });
    expect(parsePerformer("  ")).toBeNull();
    const cands = [...fallbackPlayers(), { performer: { kind: "actor" as const, actor: "BP_Guard_C_2" }, label: "Guard 2", capabilities: ["move" as const] }];
    expect(resolvePerformer("guard 2", cands)).toEqual({ kind: "actor", actor: "BP_Guard_C_2" });
    expect(resolvePerformer("Editor", cands)).toEqual({ kind: "player", client: 0 });
    expect(resolvePerformer("Client 7")).toEqual({ kind: "player", client: 7 });
    expect(resolvePerformer("", cands)).toBeNull();
  });

  it("knows which lanes each kind takes", () => {
    expect(takesLane({ kind: "player", client: 0 }, "input")).toBe(true);
    expect(takesLane({ kind: "player", client: 0 }, "move")).toBe(false);
    expect(takesLane({ kind: "actor", actor: "A" }, "move")).toBe(true);
    expect(takesLane({ kind: "actor", actor: "A" }, "input")).toBe(false);
    expect(PERFORMER_COPY.takes(["move", "action", "value"])).toBe("Takes move, action and value lanes");
  });

  it("groups the picker: players, then actors with pawns first, keeping a current performer the list lacks", () => {
    const view: PerformersView = {
      level: "/Game/Maps/L_Keep",
      performers: [
        ...fallbackPlayers(),
        { performer: { kind: "actor", actor: "Gate" }, label: "Gate", className: "BP_Gate_C", capabilities: ["move", "action", "value"] },
        { performer: { kind: "actor", actor: "Wolf" }, label: "Wolf", className: "BP_Wolf_C", pawn: true, capabilities: ["move", "action", "value"] },
      ],
    };
    const g = performerGroups(view, { kind: "actor", actor: "Boss" });
    expect(g.players.map((c) => performerId(c.performer))).toEqual(["player:0", "player:1", "player:2", "player:3"]);
    expect(g.actors.map((c) => c.label)).toEqual(["Boss", "Wolf", "Gate"]);
    expect(performerGroups(null).players).toHaveLength(4);
    expect(performerGroups(null, { kind: "player", client: 9 }).players[0].label).toBe("Client 9");
  });

  it("places performer findings from a scene's or a run's composition on the instance they are about", () => {
    const f = (id: string): ArrangementFinding => ({ id, field: "performer", message: `${id}: Guard 2 takes move, action, value lanes, and the clip has an Input Action lane for IA_Jump`, blocks: true });
    expect(placePerformerFindings([f("door/2-i2")], SET)).toEqual([expect.objectContaining({ id: "guard/i2", message: "Guard 2 takes move, action, value lanes, and the clip has an Input Action lane for IA_Jump" })]);
    // A track run numbers nothing; an arrangement run numbers the tracks that sound.
    expect(placePerformerFindings([f("i2")], SET, runTracksOf({ kind: "track", goalId: "guard" }, SET))[0].id).toBe("guard/i2");
    expect(runTracksOf({ kind: "arrangement" }, SET)).toEqual(["hero", "guard"]);
    expect(placePerformerFindings([f("2-i1")], SET, runTracksOf({ kind: "arrangement" }, SET))[0].id).toBe("guard/i1");
    // One finding seen through two scenes is shown once; a finding of another field is left as it is.
    const twice = placePerformerFindings([f("door/2-i2"), f("guard/i2"), { id: "door", field: "tracks", message: "x", blocks: false }], SET);
    expect(twice.map((x) => x.id)).toEqual(["guard/i2", "door"]);
  });

  it("shows a scene's performer finding in the Arrangement, on its block", () => {
    const set = { ...SET, findings: [{ id: "door/2-i1", field: "performer", message: "2-i1: Guard 2 takes move, action, value lanes", blocks: true }, { id: "door", field: "tracks", message: "nothing plays", blocks: false }] } as SetAnswer;
    expect(arrangementFindings(set).map((x) => x.id)).toEqual(["guard/i1"]);
  });
});
