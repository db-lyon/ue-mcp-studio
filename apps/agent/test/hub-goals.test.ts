/**
 * Goals as files in the project: one per goal, stable and diff-friendly,
 * validated on read with problems reported rather than thrown, milestones one
 * level deep, and edits from outside Studio picked up.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalStore, goalText, parseGoal } from "../src/hub/goals.js";
import { HubError } from "../src/hub/util.js";

let root: string;
let changes: Array<string | undefined>;
let clock: number;
const dir = () => path.join(root, "QA", "Goals");
const store = () => new GoalStore({ projectDir: root, now: () => new Date(Date.UTC(2026, 10, 23, 0, clock++)).toISOString(), changed: (id) => void changes.push(id) });
const status = (f: () => unknown): number => {
  try {
    f();
  } catch (e) {
    if (e instanceof HubError) return e.status;
    throw e;
  }
  return 200;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-goals-"));
  changes = [];
  clock = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("GoalStore", () => {
  it("writes a goal as its own file: fixed key order, two-space indent, trailing newline", () => {
    const s = store();
    const g = s.create({ title: "A new player finishes the tutorial", checks: [{ kind: "script", target: "/Game/Tests/Tutorial.Tutorial" }], priority: "p1" });
    expect(g.id).toBe("a-new-player-finishes-the-tutorial");
    const text = fs.readFileSync(path.join(dir(), `${g.id}.json`), "utf-8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["schema", "id", "kind", "title", "priority", "acceptance", "checks", "createdAt", "updatedAt"]);
    expect(text).toContain('\n  "title": "A new player finishes the tutorial",\n');
    // The object name is dropped from a script's path.
    expect(g.checks).toEqual([{ kind: "script", target: "/Game/Tests/Tutorial" }]);
    expect(changes).toEqual([g.id]);
  });

  it("the same goal always writes the same text", () => {
    const g = store().create({ title: "Same", tags: ["b", "a"] });
    expect(goalText(g)).toBe(goalText(JSON.parse(goalText(g))));
  });

  it("makes ids unique from the title, and refuses an asked id that is taken", () => {
    const s = store();
    expect(s.create({ title: "Jump" }).id).toBe("jump");
    expect(s.create({ title: "Jump" }).id).toBe("jump-2");
    expect(s.create({ title: "Other", id: "custom-id" }).id).toBe("custom-id");
    expect(status(() => s.create({ title: "x", id: "jump" }))).toBe(409);
    expect(status(() => s.create({ title: "x", id: "Bad Id" }))).toBe(400);
    expect(status(() => s.create({ title: "" }))).toBe(400);
  });

  it("validates updates and keeps what it was not given", () => {
    const s = store();
    const g = s.create({ title: "Door", description: "Opens", checks: [{ kind: "script", target: "/Game/T/Door" }] });
    const u = s.update(g.id, { acceptance: { stableRuns: 3 } });
    expect(u.acceptance).toEqual({ stableRuns: 3, staleAfterDays: 14, signOff: false });
    expect(u.description).toBe("Opens");
    expect(u.createdAt).toBe(g.createdAt);
    expect(u.updatedAt > g.updatedAt).toBe(true);
    expect(status(() => s.update(g.id, { acceptance: { stableRuns: 11 } }))).toBe(400);
    expect(status(() => s.update(g.id, { checks: [{ kind: "script", target: "Game/NoSlash" }] }))).toBe(400);
    expect(status(() => s.update(g.id, { due: "tomorrow" }))).toBe(400);
    expect(status(() => s.update("nope", { title: "x" }))).toBe(404);
    expect(s.update(g.id, { description: null as unknown as string }).description).toBeUndefined();
  });

  it("nests one level: a goal's parent is a milestone, a milestone has none", () => {
    const s = store();
    const m = s.create({ title: "Alpha", kind: "milestone" });
    const g = s.create({ title: "Door", parent: m.id });
    expect(g.parent).toBe(m.id);
    const other = s.create({ title: "Other" });
    expect(status(() => s.create({ title: "x", parent: other.id }))).toBe(400);
    expect(status(() => s.create({ title: "x", kind: "milestone", parent: m.id }))).toBe(400);
    expect(status(() => s.update(m.id, { kind: "goal" }))).toBe(409);
    expect(status(() => s.update(g.id, { kind: "milestone" }))).toBe(400);
    // Deleting the milestone leaves its goals on their own.
    s.delete(m.id);
    expect(s.get(g.id)?.parent).toBeUndefined();
    expect(fs.existsSync(path.join(dir(), `${m.id}.json`))).toBe(false);
  });

  it("adds checks once each, removes one by id, signs off and clears it", () => {
    const s = store();
    const g = s.create({ title: "Door" });
    const a = s.addChecks(g.id, [{ kind: "script", target: "/Game/T/A" }, { kind: "manual", target: "Looks right" }, { kind: "script", target: "/Game/T/A.A" }]);
    expect(a.checks.map((c) => c.target)).toEqual(["/Game/T/A", "Looks right"]);
    expect(status(() => s.addChecks(g.id, []))).toBe(400);
    expect(s.removeCheck(g.id, "script:/Game/T/A").checks).toHaveLength(1);
    expect(status(() => s.removeCheck(g.id, "script:/Game/T/A"))).toBe(404);
    const signed = s.signOff(g.id, "octocat", "Played it");
    expect(signed.signOff).toMatchObject({ by: "octocat", note: "Played it" });
    expect(s.clearSignOff(g.id).signOff).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir(), `${g.id}.json`), "utf-8"))).not.toHaveProperty("signOff");
  });

  it("reports files that do not parse or are not goals, and loads the rest", () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "good.json"), JSON.stringify({ schema: 1, title: "Good", checks: [{ kind: "script", target: "/Game/A" }, { kind: "nope" }] }));
    fs.writeFileSync(path.join(dir(), "broken.json"), "{ not json");
    fs.writeFileSync(path.join(dir(), "untitled.json"), JSON.stringify({ schema: 1 }));
    fs.writeFileSync(path.join(dir(), "Bad Name.json"), JSON.stringify({ title: "x" }));
    fs.writeFileSync(path.join(dir(), "future.json"), JSON.stringify({ schema: 9, title: "x" }));
    fs.writeFileSync(path.join(dir(), "orphan.json"), JSON.stringify({ title: "Orphan", parent: "gone" }));
    const s = store();
    expect(s.list().map((g) => g.id).sort()).toEqual(["good", "orphan"]);
    expect(s.get("good")?.checks).toHaveLength(1);
    const w = s.warnings().join("\n");
    expect(w).toContain("broken.json is not valid JSON");
    expect(w).toContain("untitled.json was not loaded: it has no title");
    expect(w).toContain("Bad Name.json");
    expect(w).toContain("newer Studio");
    expect(w).toContain("check 2 is not a check");
    expect(w).toContain('parent "gone" is not a milestone');
  });

  it("keeps fields a newer Studio wrote", () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "door.json"), JSON.stringify({ schema: 1, id: "door", title: "Door", zeta: 1, alpha: { x: true } }));
    const s = store();
    s.update("door", { title: "Door opens" });
    const back = JSON.parse(fs.readFileSync(path.join(dir(), "door.json"), "utf-8"));
    expect(back).toMatchObject({ title: "Door opens", alpha: { x: true }, zeta: 1 });
    expect(Object.keys(back).slice(-2)).toEqual(["alpha", "zeta"]);
  });

  it("an edit from outside Studio is read again and announced; its own write is not announced twice", () => {
    const s = store();
    const g = s.create({ title: "Door" });
    changes = [];
    expect(s.refresh()).toBe(false);
    const file = path.join(dir(), `${g.id}.json`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace('"Door"', '"Door, edited"'));
    expect(s.refresh()).toBe(true);
    expect(s.get(g.id)?.title).toBe("Door, edited");
    expect(changes).toEqual([g.id]);
    fs.rmSync(file);
    expect(s.refresh()).toBe(true);
    expect(s.get(g.id)).toBeUndefined();
  });

  it("parseGoal refuses an id that is not its file's", () => {
    expect(parseGoal({ id: "a", title: "x" }, "b", "t")).toEqual({ problem: 'its id "a" is not its file name' });
  });
});
