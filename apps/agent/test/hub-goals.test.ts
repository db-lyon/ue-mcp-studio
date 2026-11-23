/**
 * Goals as files in the project: one per goal, written only when asked,
 * patched so what this Studio does not know survives, through source control,
 * validated on read with problems reported rather than thrown, and edits from
 * outside Studio picked up.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalStore, goalText, parseGoal } from "../src/hub/goals.js";
import { HubError } from "../src/hub/util.js";
import { projectWriter, type Exec, type ProjectWriter } from "../src/vcs.js";

let root: string;
let changes: Array<string | undefined>;
const dir = () => path.join(root, "QA", "Goals");
const file = (id: string) => path.join(dir(), `${id}.json`);
const read = (id: string) => fs.readFileSync(file(id), "utf-8");
const put = (id: string, v: unknown) => {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(id), typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`);
};
const store = (writer?: ProjectWriter) => new GoalStore({ projectDir: root, changed: (id) => void changes.push(id), ...(writer ? { writer } : {}) });
const status = async (f: () => unknown): Promise<number> => {
  try {
    await f();
  } catch (e) {
    if (e instanceof HubError) return e.status;
    throw e;
  }
  return 200;
};
const SUFFIXED = (slug: string) => new RegExp(`^${slug}-[0-9a-z]{4}$`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-goals-"));
  changes = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("GoalStore", () => {
  it("writes a new goal as its own file: fixed key order, two-space indent, trailing newline, nothing that changes with time", async () => {
    const s = store();
    const g = await s.create({ title: "A new player finishes the tutorial", checks: [{ kind: "script", target: "/Game/Tests/Tutorial.Tutorial" }], priority: "p1" });
    expect(g.id).toMatch(SUFFIXED("a-new-player-finishes-the-tutorial"));
    const text = read(g.id);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["$schema", "schema", "id", "kind", "title", "priority", "acceptance", "checks"]);
    expect(JSON.parse(text).$schema).toBe("./goal.schema.json");
    expect(text).toContain('\n  "title": "A new player finishes the tutorial",\n');
    // The object name is dropped from a script's path.
    expect(g.checks).toEqual([{ kind: "script", target: "/Game/Tests/Tutorial" }]);
    expect(changes).toEqual([g.id]);
  });

  it("the same goal always writes the same text", async () => {
    const g = await store().create({ title: "Same", tags: ["b", "a"] });
    expect(goalText(g)).toBe(goalText(JSON.parse(goalText(g))));
  });

  it("gives a new goal the title's slug and a random ending, keeps an asked id, and refuses a taken or bad one", async () => {
    const s = store();
    const a = await s.create({ title: "Player can jump" });
    const b = await s.create({ title: "Player can jump" });
    expect(a.id).toMatch(SUFFIXED("player-can-jump"));
    expect(b.id).toMatch(SUFFIXED("player-can-jump"));
    expect(a.id).not.toBe(b.id);
    // Another computer makes another ending for the same title.
    expect(store().planCreate({ title: "Player can jump" }).id).not.toBe(s.planCreate({ title: "Player can jump" }).id);
    // A title with nothing ASCII still makes a valid id.
    expect((await s.create({ title: "ジャンプ" })).id).toMatch(SUFFIXED("goal"));
    expect((await s.create({ title: "Other", id: "custom-id" })).id).toBe("custom-id");
    expect(await status(() => s.create({ title: "x", id: "custom-id" }))).toBe(409);
    expect(await status(() => s.create({ title: "x", id: "Bad Id" }))).toBe(400);
    expect(await status(() => s.create({ title: "" }))).toBe(400);
  });

  it("creates the goal its preview showed: the same draft plans the same id until it is written", async () => {
    const s = store();
    const draft = { title: "Door opens" };
    const planned = s.planCreate(draft).id;
    expect(s.planCreate(draft).id).toBe(planned);
    expect((await s.create(draft)).id).toBe(planned);
  });

  it("validates updates and keeps what it was not given", async () => {
    const s = store();
    const g = await s.create({ title: "Door", description: "Opens", checks: [{ kind: "script", target: "/Game/T/Door" }] });
    const u = await s.update(g.id, { acceptance: { stableRuns: 3 } });
    expect(u.acceptance).toEqual({ stableRuns: 3, staleAfterDays: 14, signOff: false });
    expect(u.description).toBe("Opens");
    expect(await status(() => s.update(g.id, { acceptance: { stableRuns: 11 } }))).toBe(400);
    expect(await status(() => s.update(g.id, { checks: [{ kind: "script", target: "Game/NoSlash" }] }))).toBe(400);
    expect(await status(() => s.update(g.id, { due: "tomorrow" }))).toBe(400);
    expect(await status(() => s.update(g.id, { signOff: { by: "x", at: "y" } }))).toBe(400);
    expect(await status(() => s.update("nope", { title: "x" }))).toBe(404);
    expect((await s.update(g.id, { description: null as unknown as string })).description).toBeUndefined();
  });

  it("a goal sits under any number of milestones, the edge only in each milestone's file", async () => {
    const s = store();
    const a = await s.create({ title: "Alpha", kind: "milestone" });
    const b = await s.create({ title: "Beta", kind: "milestone" });
    const door = await s.create({ title: "Door", parents: [a.id, b.id] });
    expect(JSON.parse(read(door.id))).not.toHaveProperty("requires");
    expect(JSON.parse(read(door.id))).not.toHaveProperty("parent");
    expect(s.get(a.id)?.requires).toEqual([{ goal: door.id }]);
    expect(s.get(b.id)?.requires).toEqual([{ goal: door.id }]);
    const keys = Object.keys(JSON.parse(read(a.id)));
    expect(keys.indexOf("requires")).toBe(keys.indexOf("checks") - 1);
    // Parents given on an update are exactly the parents after it.
    await s.update(door.id, { parents: [b.id] });
    expect(s.get(a.id)?.requires).toBeUndefined();
    expect(s.get(b.id)?.requires).toEqual([{ goal: door.id }]);
    expect(read(door.id)).not.toContain("parents");
    expect(await status(() => s.update(door.id, { parents: ["nope"] }))).toBe(400);
    expect(await status(() => s.update(door.id, { parents: [door.id] }))).toBe(400);
    expect(await status(() => s.create({ title: "x", parent: a.id }))).toBe(400);
    // A milestone can become a goal and back: it is a label.
    expect((await s.update(b.id, { kind: "goal" })).kind).toBe("goal");
    // Deleting the goal takes it out of every parent.
    await s.addRequire(a.id, { goal: door.id });
    await s.delete(door.id);
    expect(s.get(a.id)?.requires).toBeUndefined();
    expect(s.get(b.id)?.requires).toBeUndefined();
    expect(fs.existsSync(file(door.id))).toBe(false);
  });

  it("adds, re-flags, reorders and removes required goals, and reorders checks", async () => {
    const s = store();
    const m = await s.create({ title: "M", kind: "milestone" });
    for (const id of ["a", "b", "c"]) await s.create({ title: id.toUpperCase(), id });
    await s.addRequire(m.id, { goal: "a" });
    await s.addRequire(m.id, { goal: "b", required: false });
    await s.addRequire(m.id, "c");
    expect(s.get(m.id)?.requires).toEqual([{ goal: "a" }, { goal: "b", required: false }, { goal: "c" }]);
    // Again: keeps its place, takes the new flag; the same flag writes nothing.
    changes = [];
    await s.addRequire(m.id, { goal: "a" });
    expect(changes).toEqual([]);
    await s.addRequire(m.id, { goal: "b", required: true });
    expect(s.get(m.id)?.requires?.[1]).toEqual({ goal: "b" });
    expect((await s.orderRequires(m.id, { order: ["c", "a", "b"] })).requires?.map((r) => r.goal)).toEqual(["c", "a", "b"]);
    expect(await status(() => s.orderRequires(m.id, { order: ["c", "a"] }))).toBe(400);
    expect((await s.removeRequire(m.id, "a")).requires?.map((r) => r.goal)).toEqual(["c", "b"]);
    expect(await status(() => s.removeRequire(m.id, "a"))).toBe(404);
    expect(await status(() => s.addRequire(m.id, { goal: "nope" }))).toBe(400);
    expect(await status(() => s.addRequire(m.id, { goal: m.id }))).toBe(400);
    const g = await s.create({ title: "Checks", checks: [{ kind: "script", target: "/Game/T/A" }, { kind: "script", target: "/Game/T/B" }] });
    expect((await s.orderChecks(g.id, { order: ["script:/Game/T/B", "script:/Game/T/A"] })).checks.map((c) => c.target)).toEqual(["/Game/T/B", "/Game/T/A"]);
    expect(await status(() => s.orderChecks(g.id, { order: ["script:/Game/T/B"] }))).toBe(400);
  });

  it("refuses a loop with its path, on every way an edge is made", async () => {
    const s = store();
    for (const id of ["a", "b", "c"]) await s.create({ title: id, id });
    await s.addRequire("a", { goal: "b" });
    await s.addRequire("b", { goal: "c" });
    const why = async (f: () => Promise<unknown>): Promise<string> => {
      try {
        await f();
      } catch (e) {
        return `${(e as HubError).status} ${(e as Error).message}`;
      }
      return "ok";
    };
    expect(await why(() => s.addRequire("c", { goal: "a" }))).toBe("400 that would make goals require each other in a loop: c > a > b > c");
    expect(await why(() => s.update("c", { requires: [{ goal: "a" }] }))).toContain("c > a > b > c");
    expect(await why(() => s.update("a", { parents: ["c"] }))).toContain("c > a > b > c");
    expect(await why(() => s.create({ title: "D", id: "d", requires: [{ goal: "a" }], parents: ["c"] }))).toContain("loop");
    expect(s.get("c")?.requires).toBeUndefined();
    expect(fs.existsSync(file("d"))).toBe(false);
  });

  it("reports a loop written by hand and a required goal that is not there", () => {
    put("a", { title: "A", requires: [{ goal: "b" }, { goal: "gone" }, { goal: "a" }] });
    put("b", { title: "B", requires: [{ goal: "a" }] });
    const w = store().warnings().join("\n");
    expect(w).toContain("goals require each other in a loop (a > b > a)");
    expect(w).toContain('it requires "gone", which is not here');
    expect(w).toContain("it requires itself");
  });

  it("adds checks once each and removes one by id", async () => {
    const s = store();
    const g = await s.create({ title: "Door" });
    const a = await s.addChecks(g.id, [{ kind: "script", target: "/Game/T/A" }, { kind: "manual", target: "Looks right" }, { kind: "script", target: "/Game/T/A.A" }]);
    expect(a.checks.map((c) => c.target)).toEqual(["/Game/T/A", "Looks right"]);
    expect(await status(() => s.addChecks(g.id, []))).toBe(400);
    expect((await s.removeCheck(g.id, "script:/Game/T/A")).checks).toHaveLength(1);
    expect(await status(() => s.removeCheck(g.id, "script:/Game/T/A"))).toBe(404);
  });

  it("reports files that do not parse, have conflict markers or are not goals, and loads the rest", () => {
    put("good", { schema: 1, title: "Good", checks: [{ kind: "script", target: "/Game/A" }, { kind: "nope" }] });
    put("broken", "{ not json");
    put("untitled", { schema: 1 });
    put("Bad Name", { title: "x" });
    put("future", { schema: 9, title: "x" });
    put("orphan", { title: "Orphan", parent: "gone" });
    put("merged", '{\n  "title": "Merged",\n<<<<<<< HEAD\n  "priority": "p1"\n=======\n  "priority": "p2"\n>>>>>>> feature\n}\n');
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
    expect(w).toContain("QA/Goals/merged.json has merge conflict markers, so it is left out until the conflict is resolved");
  });

  it("an edit from outside Studio is read again and announced; its own write is not announced twice", async () => {
    const s = store();
    const g = await s.create({ title: "Door" });
    changes = [];
    expect(s.refresh()).toBe(false);
    fs.writeFileSync(file(g.id), read(g.id).replace('"Door"', '"Door, edited"'));
    expect(s.refresh()).toBe(true);
    expect(s.get(g.id)?.title).toBe("Door, edited");
    expect(changes).toEqual([g.id]);
    fs.rmSync(file(g.id));
    expect(s.refresh()).toBe(true);
    expect(s.get(g.id)).toBeUndefined();
  });

  it("parseGoal refuses an id that is not its file's", () => {
    expect(parseGoal({ id: "a", title: "x" }, "b")).toEqual({ problem: 'its id "a" is not its file name' });
  });
});

describe("writes patch the file", () => {
  it("changes only the members that changed, keeping unknown ones, their order and values this Studio cannot read", async () => {
    put("door", {
      zeta: 1,
      title: "Door",
      priority: "p9",
      createdAt: "2026-01-01T00:00:00Z",
      checks: [
        { kind: "gauntlet", target: "door-suite", weight: 3 },
        { kind: "script", target: "/Game/T/A", weight: 2 },
      ],
      updatedAt: "2026-02-01T00:00:00Z",
      alpha: { x: true },
    });
    const s = store();
    await s.update("door", { title: "Door opens" });
    const back = JSON.parse(read("door"));
    expect(Object.keys(back)).toEqual(["zeta", "title", "priority", "createdAt", "checks", "updatedAt", "alpha"]);
    expect(back).toMatchObject({ title: "Door opens", priority: "p9", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", alpha: { x: true } });
    // Nothing Studio fills in by default is added on an unrelated change.
    expect(back).not.toHaveProperty("schema");
    expect(back).not.toHaveProperty("$schema");
    expect(back).not.toHaveProperty("acceptance");

    // A change to the list keeps the entry it cannot read in place and the known entry's own extra field.
    await s.addChecks("door", [{ kind: "script", target: "/Game/T/B" }]);
    expect(JSON.parse(read("door")).checks).toEqual([
      { kind: "gauntlet", target: "door-suite", weight: 3 },
      { kind: "script", target: "/Game/T/A", weight: 2 },
      { kind: "script", target: "/Game/T/B" },
    ]);
    await s.updateCheck("door", "script:/Game/T/A", { required: false });
    expect(JSON.parse(read("door")).checks[1]).toEqual({ kind: "script", target: "/Game/T/A", weight: 2, required: false });
    await s.removeCheck("door", "script:/Game/T/A");
    expect(JSON.parse(read("door")).checks).toEqual([{ kind: "gauntlet", target: "door-suite", weight: 3 }, { kind: "script", target: "/Game/T/B" }]);
  });

  it("puts a key the file gains where the fixed order would, and writes one acceptance member alone", async () => {
    put("door", { title: "Door", checks: [] });
    const s = store();
    await s.update("door", { links: [{ url: "https://example.com/1" }], acceptance: { stableRuns: 2 } });
    const back = JSON.parse(read("door"));
    expect(Object.keys(back)).toEqual(["title", "links", "acceptance", "checks"]);
    expect(back.acceptance).toEqual({ stableRuns: 2 });
  });

  it("keeps the file's line endings and a $schema it names, and adds no $schema to a file without one", async () => {
    put("a", { $schema: "https://example.com/goal.json", title: "A" });
    put("b", JSON.stringify({ title: "B", priority: "p1" }, null, 2).replace(/\n/g, "\r\n"));
    const s = store();
    await s.update("a", { title: "A2" });
    await s.update("b", { title: "B2" });
    expect(JSON.parse(read("a")).$schema).toBe("https://example.com/goal.json");
    expect(JSON.parse(read("b"))).not.toHaveProperty("$schema");
    expect(read("b")).toBe('{\r\n  "title": "B2",\r\n  "priority": "p1"\r\n}\r\n');
  });

  it("two edits of different fields made from the same file touch different lines, so they merge", async () => {
    const s = store();
    const g = await s.create({ title: "Door", checks: [{ kind: "script", target: "/Game/T/A" }] });
    const base = read(g.id).split("\n");
    await s.update(g.id, { links: [{ url: "https://example.com/1" }] });
    const withLink = read(g.id).split("\n");
    expect(withLink.filter((l) => !base.includes(l)).every((l) => /links|url|^\s*[[\]{}],?$/.test(l))).toBe(true);
    expect(base.filter((l) => !withLink.includes(l))).toEqual([]);
  });

  it("writes nothing when a change leaves the text as it is", async () => {
    put("door", { title: "Door", checks: [{ kind: "script", target: "/Game/T/A" }] });
    const writes: string[] = [];
    const s = store({ write: async (f, t) => void (writes.push(f), fs.writeFileSync(f, t)), remove: async (f) => fs.rmSync(f) });
    await s.addChecks("door", [{ kind: "script", target: "/Game/T/A.A" }]);
    await s.orderChecks("door", { order: ["script:/Game/T/A"] });
    expect(writes).toEqual([]);
  });
});

describe("nothing is written unless asked", () => {
  it("starting on a project with goals writes nothing: not the README, the schema or any goal", () => {
    put("door", { title: "Door", parent: "m" });
    put("m", { title: "M", kind: "milestone" });
    const before = fs.readdirSync(dir()).map((n) => [n, fs.readFileSync(path.join(dir(), n), "utf-8")]);
    const s = store();
    s.refresh();
    store();
    expect(fs.readdirSync(dir()).map((n) => [n, fs.readFileSync(path.join(dir(), n), "utf-8")])).toEqual(before);
  });

  it("the README and schema come with a goal created while they are missing, and are never rewritten", async () => {
    const readme = path.join(dir(), "README.md");
    const schema = path.join(dir(), "goal.schema.json");
    const s = store();
    expect(fs.existsSync(dir())).toBe(false);
    const g = await s.create({ title: "Door" });
    const text = fs.readFileSync(readme, "utf-8");
    expect(text).toContain("# Goals");
    expect(text).not.toContain("—");
    expect(fs.existsSync(schema)).toBe(true);
    // The schema is not read as a goal.
    expect(store().warnings()).toEqual([]);
    expect(store().list().map((x) => x.id)).toEqual([g.id]);
    // The team's edits stay, whatever Studio does next.
    fs.writeFileSync(readme, "Our conventions");
    fs.rmSync(schema);
    await s.update(g.id, { title: "Door opens" });
    store();
    expect(fs.readFileSync(readme, "utf-8")).toBe("Our conventions");
    expect(fs.existsSync(schema)).toBe(false);
    // A goal created later brings back only what is missing.
    await s.create({ title: "Window" });
    expect(fs.readFileSync(readme, "utf-8")).toBe("Our conventions");
    expect(fs.existsSync(schema)).toBe(true);
  });
});

describe("files with an old parent", () => {
  const old = () => {
    put("m", { schema: 1, id: "m", kind: "milestone", title: "M", requires: [{ goal: "x" }] });
    put("x", { schema: 1, id: "x", title: "X" });
    put("b", { schema: 1, id: "b", title: "B", parent: "m" });
    put("a", { schema: 1, id: "a", title: "A", parent: "m" });
    return { m: read("m"), a: read("a"), b: read("b") };
  };

  it("reads parent as an entry at the end of the parent's requires, in file-name order, and writes nothing", () => {
    const before = old();
    const s = store();
    expect(s.get("m")?.requires).toEqual([{ goal: "x" }, { goal: "a" }, { goal: "b" }]);
    expect(s.get("a")).not.toHaveProperty("parent");
    expect(s.warnings()).toEqual([]);
    expect(s.refresh()).toBe(false);
    store();
    expect({ m: read("m"), a: read("a"), b: read("b") }).toEqual(before);
  });

  it("saving the child alone touches only the child, and keeps parent until the milestone lists it", async () => {
    const before = old();
    const s = store();
    await s.update("a", { title: "A2" });
    expect(JSON.parse(read("a")).parent).toBe("m");
    expect(read("m")).toBe(before.m);
    expect(read("b")).toBe(before.b);
    expect(store().get("m")?.requires).toEqual([{ goal: "x" }, { goal: "a" }, { goal: "b" }]);
  });

  it("saving the milestone writes the entries into it; the children drop parent when they are saved after", async () => {
    const before = old();
    const s = store();
    await s.update("m", { title: "M2" });
    expect(JSON.parse(read("m")).requires).toEqual([{ goal: "x" }, { goal: "a" }, { goal: "b" }]);
    expect(read("a")).toBe(before.a);
    await s.update("a", { title: "A2" });
    expect(JSON.parse(read("a"))).not.toHaveProperty("parent");
    expect(store().get("m")?.requires).toEqual([{ goal: "x" }, { goal: "a" }, { goal: "b" }]);
    expect(store().warnings()).toEqual([]);
  });

  it("removing an old child from the milestone drops its parent too, so the removal sticks", async () => {
    old();
    const s = store();
    await s.removeRequire("m", "a");
    expect(JSON.parse(read("a"))).not.toHaveProperty("parent");
    expect(JSON.parse(read("b")).parent).toBe("m");
    expect(store().get("m")?.requires).toEqual([{ goal: "x" }, { goal: "b" }]);
  });

  it("deleting the old parent drops parent from its old children", async () => {
    old();
    await store().delete("m");
    expect(JSON.parse(read("a"))).not.toHaveProperty("parent");
    expect(store().warnings()).toEqual([]);
  });
});

describe("links", () => {
  const issue = { url: "https://git.example.com/ember/hollow/issues/42", title: "Tutorial glade", rel: "counterpart" };

  it("keeps a goal's links, written after due and before acceptance, and validates them", async () => {
    const s = store();
    const g = await s.create({ title: "Door", due: "2026-12-01", links: [issue, { url: "jira://HOL-1" }, { url: issue.url, title: "Twice" }] });
    expect(g.links).toEqual([issue, { url: "jira://HOL-1" }]);
    const back = JSON.parse(read(g.id));
    const keys = Object.keys(back);
    expect(keys.indexOf("links")).toBe(keys.indexOf("due") + 1);
    expect(back.links[0]).toEqual(issue);
    expect(await status(() => s.update(g.id, { links: [{ url: "javascript:alert(1)" }] }))).toBe(400);
    expect(await status(() => s.update(g.id, { links: [{ url: "no scheme" }] }))).toBe(400);
    expect((await s.update(g.id, { links: [{ url: "mailto:qa@example.com" }] })).links).toEqual([{ url: "mailto:qa@example.com" }]);
    // An empty list clears them, and the file drops the key.
    expect((await s.update(g.id, { links: [] })).links).toBeUndefined();
    expect(JSON.parse(read(g.id))).not.toHaveProperty("links");
  });

  it("changes one check's title, required and links in place", async () => {
    const s = store();
    const g = await s.create({ title: "Door", checks: [{ kind: "script", target: "/Game/T/A" }, { kind: "manual", target: "Looks right" }] });
    const u = await s.updateCheck(g.id, "script:/Game/T/A", { title: "Opens", required: false, links: [issue] });
    expect(u.checks[0]).toEqual({ kind: "script", target: "/Game/T/A", title: "Opens", required: false, links: [issue] });
    expect(u.checks[1]).toEqual({ kind: "manual", target: "Looks right" });
    const cleared = await s.updateCheck(g.id, "script:/Game/T/A", { title: null, required: true, links: [] });
    expect(cleared.checks[0]).toEqual({ kind: "script", target: "/Game/T/A" });
    expect(await status(() => s.updateCheck(g.id, "script:/Game/T/Nope", { title: "x" }))).toBe(404);
  });

  it("reads links from a file, dropping and reporting the bad ones, and keeps them in the file", async () => {
    put("door", { title: "Door", links: [issue, { url: "javascript:x" }], checks: [{ kind: "script", target: "/Game/A", links: [{ title: "no url" }, { url: "https://trello.com/c/abc" }] }] });
    const s = store();
    expect(s.get("door")?.links).toEqual([issue]);
    expect(s.get("door")?.checks[0].links).toEqual([{ url: "https://trello.com/c/abc" }]);
    const w = s.warnings().join("\n");
    expect(w).toContain("link 2: javascript: links are not allowed");
    expect(w).toContain("check 1 link 1");
    await s.update("door", { links: [issue, { url: "jira://HOL-2" }] });
    expect(JSON.parse(read("door")).links).toEqual([issue, { url: "javascript:x" }, { url: "jira://HOL-2" }]);
  });
});

describe("under Perforce", () => {
  /** A fake p4: files in the depot and what each is open for, read-only until opened as Perforce leaves them. */
  function fakeP4(depot: Map<string, string>, refuse: (verb: string, file: string) => string | null = () => null) {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      const f = args[args.length - 1];
      const verb = args[0] === "-s" ? args[1] : args.includes("fstat") ? "fstat" : args.includes("info") ? "info" : args[0];
      calls.push(verb === "info" ? "info" : `${verb} ${path.basename(f)}`);
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
      if (verb === "info") return ok(`ws|${root}|//stream/main|dev\n`);
      if (verb === "fstat") return depot.has(f) ? ok(`//stream/main/${path.basename(f)}|edit|${depot.get(f)}\n`) : { code: 1, stdout: "", stderr: `${f} - no such file(s).\n` };
      const no = refuse(verb, f);
      if (no) return ok(`error: ${no}\nexit: 1\n`);
      if (verb === "edit") fs.chmodSync(f, 0o666);
      if (verb === "delete") fs.rmSync(f);
      if (verb === "revert") {
        if (depot.get(f) === "add") depot.delete(f);
        else {
          fs.chmodSync(f, 0o444);
          depot.set(f, "");
        }
      } else depot.set(f, verb);
      return ok(`info: ${path.basename(f)} - opened for ${verb}\nexit: 0\n`);
    };
    return { calls, writer: projectWriter(exec) };
  }
  const synced = (id: string, v: unknown, depot: Map<string, string>) => {
    put(id, v);
    fs.chmodSync(file(id), 0o444);
    depot.set(file(id), "");
  };

  it("opens a checked-in goal for edit before writing it, adds a new one and deletes a removed one", async () => {
    const depot = new Map<string, string>();
    synced("door", { title: "Door" }, depot);
    const { calls, writer } = fakeP4(depot);
    const s = store(writer);
    await s.update("door", { title: "Door opens" });
    expect(calls).toEqual(["info", "fstat door.json", "edit door.json"]);
    expect(JSON.parse(read("door")).title).toBe("Door opens");
    // Already open: written without asking again.
    calls.length = 0;
    await s.update("door", { title: "Door opens wide" });
    expect(calls).toEqual(["info", "fstat door.json"]);
    calls.length = 0;
    const g = await s.create({ title: "Window", id: "window" });
    expect(calls).toEqual(["info", "fstat goal.schema.json", "add goal.schema.json", "info", "fstat README.md", "add README.md", "info", "fstat window.json", "add window.json"]);
    expect(depot.get(file(g.id))).toBe("add");
    calls.length = 0;
    await s.delete("door");
    expect(calls).toEqual(["info", "fstat door.json", "revert door.json", "delete door.json"]);
    expect(fs.existsSync(file("door"))).toBe(false);
    // A goal only added, never submitted, is reverted and removed.
    calls.length = 0;
    await s.delete("window");
    expect(calls).toEqual(["info", "fstat window.json", "revert window.json"]);
    expect(fs.existsSync(file("window"))).toBe(false);
  });

  it("reports Perforce's refusal and changes nothing", async () => {
    const depot = new Map<string, string>();
    synced("door", { title: "Door" }, depot);
    const before = read("door");
    const { writer } = fakeP4(depot, (verb) => (verb === "edit" ? "//stream/main/door.json - can't edit exclusive file already opened by ama@ama-ws" : verb === "add" ? "not logged in" : null));
    const s = store(writer);
    await expect(s.update("door", { title: "Door opens" })).rejects.toThrow("Perforce refused to edit door.json: //stream/main/door.json - can't edit exclusive file already opened by ama@ama-ws");
    expect(read("door")).toBe(before);
    expect(s.get("door")?.title).toBe("Door");
    await expect(s.create({ title: "Window", id: "window" })).rejects.toThrow("not logged in");
    expect(fs.existsSync(file("window"))).toBe(false);
  });

  it("outside Perforce a read-only file is reported as read-only", async () => {
    put("door", { title: "Door" });
    fs.chmodSync(file("door"), 0o444);
    const s = store(projectWriter(async () => ({ code: 1, stdout: "", stderr: "Perforce client error: Connect to server failed" })));
    try {
      await expect(s.update("door", { title: "Door opens" })).rejects.toThrow("door.json is read-only");
    } finally {
      fs.chmodSync(file("door"), 0o666);
    }
  });
});
