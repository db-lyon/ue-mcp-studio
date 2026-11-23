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
    expect(Object.keys(JSON.parse(text))).toEqual(["$schema", "schema", "id", "kind", "title", "priority", "acceptance", "checks", "createdAt", "updatedAt"]);
    expect(JSON.parse(text).$schema).toBe("./goal.schema.json");
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

  it("a goal sits under any number of milestones, the edge only in each milestone's file", () => {
    const s = store();
    const a = s.create({ title: "Alpha", kind: "milestone" });
    const b = s.create({ title: "Beta", kind: "milestone" });
    const door = s.create({ title: "Door", parents: [a.id, b.id] });
    const doorText = fs.readFileSync(path.join(dir(), "door.json"), "utf-8");
    expect(JSON.parse(doorText)).not.toHaveProperty("requires");
    expect(JSON.parse(doorText)).not.toHaveProperty("parent");
    expect(s.get(a.id)?.requires).toEqual([{ goal: door.id }]);
    expect(s.get(b.id)?.requires).toEqual([{ goal: door.id }]);
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir(), "alpha.json"), "utf-8")));
    expect(keys.indexOf("requires")).toBe(keys.indexOf("checks") - 1);
    // Parents given on an update are exactly the parents after it.
    s.update(door.id, { parents: [b.id] });
    expect(s.get(a.id)?.requires).toBeUndefined();
    expect(s.get(b.id)?.requires).toEqual([{ goal: door.id }]);
    expect(fs.readFileSync(path.join(dir(), "door.json"), "utf-8")).not.toContain("parents");
    expect(status(() => s.update(door.id, { parents: ["nope"] }))).toBe(400);
    expect(status(() => s.update(door.id, { parents: [door.id] }))).toBe(400);
    expect(status(() => s.create({ title: "x", parent: a.id }))).toBe(400);
    // A milestone can become a goal and back: it is a label.
    expect(s.update(b.id, { kind: "goal" }).kind).toBe("goal");
    // Deleting a parent leaves the goal; deleting the goal takes it out of every parent.
    s.addRequire(a.id, { goal: door.id });
    s.delete(door.id);
    expect(s.get(a.id)?.requires).toBeUndefined();
    expect(s.get(b.id)?.requires).toBeUndefined();
    expect(fs.existsSync(path.join(dir(), "door.json"))).toBe(false);
  });

  it("adds, re-flags, reorders and removes required goals, and reorders checks", () => {
    const s = store();
    const m = s.create({ title: "M", kind: "milestone" });
    for (const t of ["A", "B", "C"]) s.create({ title: t });
    s.addRequire(m.id, { goal: "a" });
    s.addRequire(m.id, { goal: "b", required: false });
    s.addRequire(m.id, "c");
    expect(s.get(m.id)?.requires).toEqual([{ goal: "a" }, { goal: "b", required: false }, { goal: "c" }]);
    // Again: keeps its place, takes the new flag; the same flag writes nothing.
    changes = [];
    s.addRequire(m.id, { goal: "a" });
    expect(changes).toEqual([]);
    s.addRequire(m.id, { goal: "b", required: true });
    expect(s.get(m.id)?.requires?.[1]).toEqual({ goal: "b" });
    expect(s.orderRequires(m.id, { order: ["c", "a", "b"] }).requires?.map((r) => r.goal)).toEqual(["c", "a", "b"]);
    expect(status(() => s.orderRequires(m.id, { order: ["c", "a"] }))).toBe(400);
    expect(status(() => s.orderRequires(m.id, { order: ["c", "a", "a"] }))).toBe(400);
    expect(s.removeRequire(m.id, "a").requires?.map((r) => r.goal)).toEqual(["c", "b"]);
    expect(status(() => s.removeRequire(m.id, "a"))).toBe(404);
    expect(status(() => s.addRequire(m.id, { goal: "nope" }))).toBe(400);
    expect(status(() => s.addRequire(m.id, { goal: m.id }))).toBe(400);
    const g = s.create({ title: "Checks", checks: [{ kind: "script", target: "/Game/T/A" }, { kind: "script", target: "/Game/T/B" }] });
    expect(s.orderChecks(g.id, { order: ["script:/Game/T/B", "script:/Game/T/A"] }).checks.map((c) => c.target)).toEqual(["/Game/T/B", "/Game/T/A"]);
    expect(status(() => s.orderChecks(g.id, { order: ["script:/Game/T/B"] }))).toBe(400);
  });

  it("refuses a loop with its path, on every way an edge is made", () => {
    const s = store();
    for (const t of ["A", "B", "C"]) s.create({ title: t });
    s.addRequire("a", { goal: "b" });
    s.addRequire("b", { goal: "c" });
    const why = (f: () => unknown): string => {
      try {
        f();
      } catch (e) {
        return `${(e as HubError).status} ${(e as Error).message}`;
      }
      return "ok";
    };
    expect(why(() => s.addRequire("c", { goal: "a" }))).toBe("400 that would make goals require each other in a loop: c > a > b > c");
    expect(why(() => s.update("c", { requires: [{ goal: "a" }] }))).toContain("c > a > b > c");
    expect(why(() => s.update("a", { parents: ["c"] }))).toContain("c > a > b > c");
    expect(why(() => s.create({ title: "D", requires: [{ goal: "a" }], parents: ["c"] }))).toContain("loop");
    expect(s.get("c")?.requires).toBeUndefined();
    expect(fs.existsSync(path.join(dir(), "d.json"))).toBe(false);
  });

  it("reports a loop written by hand and a required goal that is not there", () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "a.json"), JSON.stringify({ title: "A", requires: [{ goal: "b" }, { goal: "gone" }, { goal: "a" }] }));
    fs.writeFileSync(path.join(dir(), "b.json"), JSON.stringify({ title: "B", requires: [{ goal: "a" }] }));
    const s = store();
    const w = s.warnings().join("\n");
    expect(w).toContain("goals require each other in a loop (a > b > a)");
    expect(w).toContain('it requires "gone", which is not here');
    expect(w).toContain("it requires itself");
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
    expect(w).toContain('parent "gone" is not here');
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

describe("files with an old parent", () => {
  const read = (id: string) => fs.readFileSync(path.join(dir(), `${id}.json`), "utf-8");
  const old = () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "m.json"), JSON.stringify({ schema: 1, id: "m", kind: "milestone", title: "M", requires: [{ goal: "x" }] }, null, 2));
    fs.writeFileSync(path.join(dir(), "x.json"), JSON.stringify({ schema: 1, id: "x", title: "X" }, null, 2));
    fs.writeFileSync(path.join(dir(), "b.json"), JSON.stringify({ schema: 1, id: "b", title: "B", parent: "m" }, null, 2));
    fs.writeFileSync(path.join(dir(), "a.json"), JSON.stringify({ schema: 1, id: "a", title: "A", parent: "m" }, null, 2));
    return { m: read("m"), a: read("a"), b: read("b") };
  };

  it("reads parent as an entry at the end of the parent's requires, in file-name order, and writes nothing", () => {
    const before = old();
    const s = store();
    expect(s.get("m")?.requires).toEqual([{ goal: "x" }, { goal: "a" }, { goal: "b" }]);
    expect(s.get("a")).not.toHaveProperty("parent");
    expect(s.warnings()).toEqual([]);
    // Reading again, or a second store, changes nothing on disk.
    expect(s.refresh()).toBe(false);
    store();
    expect({ m: read("m"), a: read("a"), b: read("b") }).toEqual(before);
  });

  it("writing the child writes the parent with the entry and the child without parent", () => {
    old();
    const s = store();
    s.update("a", { title: "A2" });
    expect(JSON.parse(read("a"))).not.toHaveProperty("parent");
    expect(JSON.parse(read("m")).requires).toEqual([{ goal: "x" }, { goal: "a" }, { goal: "b" }]);
    // b still holds its old parent until it is written, which reads the same.
    expect(JSON.parse(read("b")).parent).toBe("m");
    const again = store();
    expect(again.get("m")?.requires).toEqual([{ goal: "x" }, { goal: "a" }, { goal: "b" }]);
    expect(again.refresh()).toBe(false);
  });

  it("writing the parent drops parent from every old child, so removing one sticks", () => {
    old();
    const s = store();
    s.removeRequire("m", "a");
    expect(JSON.parse(read("a"))).not.toHaveProperty("parent");
    expect(JSON.parse(read("b"))).not.toHaveProperty("parent");
    expect(JSON.parse(read("m")).requires).toEqual([{ goal: "x" }, { goal: "b" }]);
    expect(store().get("m")?.requires).toEqual([{ goal: "x" }, { goal: "b" }]);
  });

  it("deleting the old parent drops parent from its old children", () => {
    old();
    const s = store();
    s.delete("m");
    expect(JSON.parse(read("a"))).not.toHaveProperty("parent");
    expect(store().warnings()).toEqual([]);
  });
});

describe("links", () => {
  const issue = { url: "https://git.example.com/ember/hollow/issues/42", title: "Tutorial glade", rel: "counterpart" };

  it("keeps a goal's links, written after due and before acceptance, and validates them", () => {
    const s = store();
    const g = s.create({ title: "Door", due: "2026-12-01", links: [issue, { url: "jira://HOL-1" }, { url: issue.url, title: "Twice" }] });
    expect(g.links).toEqual([issue, { url: "jira://HOL-1" }]);
    const back = JSON.parse(fs.readFileSync(path.join(dir(), `${g.id}.json`), "utf-8"));
    const keys = Object.keys(back);
    expect(keys.indexOf("links")).toBe(keys.indexOf("due") + 1);
    expect(back.links[0]).toEqual(issue);
    expect(status(() => s.update(g.id, { links: [{ url: "javascript:alert(1)" }] }))).toBe(400);
    expect(status(() => s.update(g.id, { links: [{ url: "data:text/html,x" }] }))).toBe(400);
    expect(status(() => s.update(g.id, { links: [{ url: "no scheme" }] }))).toBe(400);
    expect(status(() => s.update(g.id, { links: "https://x.y" as unknown as [] }))).toBe(400);
    expect(s.update(g.id, { links: [{ url: "mailto:qa@example.com" }] }).links).toEqual([{ url: "mailto:qa@example.com" }]);
    // An empty list clears them, and the file drops the key.
    expect(s.update(g.id, { links: [] }).links).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir(), `${g.id}.json`), "utf-8"))).not.toHaveProperty("links");
  });

  it("changes one check's title, required and links in place", () => {
    const s = store();
    const g = s.create({ title: "Door", checks: [{ kind: "script", target: "/Game/T/A" }, { kind: "manual", target: "Looks right" }] });
    const u = s.updateCheck(g.id, "script:/Game/T/A", { title: "Opens", required: false, links: [issue] });
    expect(u.checks[0]).toEqual({ kind: "script", target: "/Game/T/A", title: "Opens", required: false, links: [issue] });
    expect(u.checks[1]).toEqual({ kind: "manual", target: "Looks right" });
    const cleared = s.updateCheck(g.id, "script:/Game/T/A", { title: null, required: true, links: [] });
    expect(cleared.checks[0]).toEqual({ kind: "script", target: "/Game/T/A" });
    expect(status(() => s.updateCheck(g.id, "script:/Game/T/Nope", { title: "x" }))).toBe(404);
    expect(status(() => s.updateCheck(g.id, "script:/Game/T/A", { links: [{ url: "javascript:x" }] }))).toBe(400);
    expect(status(() => s.update(g.id, { checks: [{ kind: "script", target: "/Game/T/A", links: [{ url: "file:///c:/x" }] }] }))).toBe(400);
  });

  it("reads links from a file, dropping and reporting the bad ones", () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "door.json"), JSON.stringify({ title: "Door", links: [issue, { url: "javascript:x" }], checks: [{ kind: "script", target: "/Game/A", links: [{ title: "no url" }, { url: "https://trello.com/c/abc" }] }] }));
    const s = store();
    expect(s.get("door")?.links).toEqual([issue]);
    expect(s.get("door")?.checks[0].links).toEqual([{ url: "https://trello.com/c/abc" }]);
    const w = s.warnings().join("\n");
    expect(w).toContain("link 2: javascript: links are not allowed");
    expect(w).toContain("check 1 link 1");
  });

  it("keeps a $schema the file already names, and adds ours to a file without one when it is next written", () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "a.json"), JSON.stringify({ $schema: "https://example.com/goal.json", title: "A" }));
    fs.writeFileSync(path.join(dir(), "b.json"), JSON.stringify({ title: "B" }));
    const s = store();
    expect(s.warnings()).toEqual([]);
    s.update("a", { title: "A2" });
    s.update("b", { title: "B2" });
    const a = JSON.parse(fs.readFileSync(path.join(dir(), "a.json"), "utf-8"));
    const b = JSON.parse(fs.readFileSync(path.join(dir(), "b.json"), "utf-8"));
    expect(Object.keys(a)[0]).toBe("$schema");
    expect(a.$schema).toBe("https://example.com/goal.json");
    expect(b.$schema).toBe("./goal.schema.json");
  });
});

describe("README.md and goal.schema.json", () => {
  const readme = () => path.join(dir(), "README.md");
  const schema = () => path.join(dir(), "goal.schema.json");

  it("are not written into a project without a goals folder until the first goal", () => {
    const s = store();
    expect(fs.existsSync(dir())).toBe(false);
    s.create({ title: "Door" });
    expect(fs.existsSync(readme())).toBe(true);
    expect(fs.existsSync(schema())).toBe(true);
    // The schema is not read as a goal.
    expect(store().warnings()).toEqual([]);
    expect(store().list().map((g) => g.id)).toEqual(["door"]);
  });

  it("are written when the folder exists, and rewritten only when their text would change", () => {
    fs.mkdirSync(dir(), { recursive: true });
    store();
    const text = fs.readFileSync(readme(), "utf-8");
    expect(text).toContain("# Goals");
    expect(text).not.toContain("\u2014");
    const old = new Date(Date.UTC(2020, 0, 1));
    fs.utimesSync(readme(), old, old);
    fs.utimesSync(schema(), old, old);
    // A checkout with Windows newlines is the same text.
    fs.writeFileSync(schema(), fs.readFileSync(schema(), "utf-8").replace(/\n/g, "\r\n"));
    fs.utimesSync(schema(), old, old);
    store().create({ title: "Door" });
    expect(fs.statSync(readme()).mtime.getTime()).toBe(old.getTime());
    expect(fs.statSync(schema()).mtime.getTime()).toBe(old.getTime());
    fs.writeFileSync(readme(), "edited");
    store();
    expect(fs.readFileSync(readme(), "utf-8")).toBe(text);
  });
});
