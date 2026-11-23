/**
 * goal.schema.json against the store: it accepts every goal the store writes,
 * the README's example included, refuses malformed goals the reader would
 * refuse or drop parts of, and names exactly the fields the store writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { GoalStore, ORDER, goalText } from "../src/hub/goals.js";
import { EXAMPLE_GOAL, GOAL_SCHEMA, GOAL_SCHEMA_TEXT } from "../src/hub/goal-docs.js";

let root: string;
const dir = () => path.join(root, "QA", "Goals");
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-docs-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
const validate = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: false }).compile(GOAL_SCHEMA);
const valid = (v: unknown): boolean => validate(v) as boolean;

describe("goal.schema.json", () => {
  it("is the file the store writes", () => {
    new GoalStore({ projectDir: root }).create({ title: "x" });
    expect(fs.readFileSync(path.join(dir(), "goal.schema.json"), "utf-8")).toBe(GOAL_SCHEMA_TEXT);
  });

  it("names every field a goal file holds, and no other", () => {
    expect(Object.keys(GOAL_SCHEMA.properties).sort()).toEqual(["$schema", ...ORDER].sort());
  });

  it("accepts every goal the store writes", () => {
    const s = new GoalStore({ projectDir: root });
    const m = s.create({ title: "Vertical Slice", kind: "milestone", due: "2026-12-18" });
    s.create({ title: "Bare" });
    const g = s.create({
      title: "A new player finishes the tutorial",
      description: "Walk, jump, leave.",
      parent: m.id,
      owner: "Ama",
      priority: "p0",
      tags: ["onboarding"],
      due: "2026-12-05",
      links: [{ url: "https://git.example.com/ember/hollow/issues/42", title: "Tutorial", rel: "counterpart" }, { url: "jira://HOL-7" }],
      acceptance: { stableRuns: 3, staleAfterDays: null, signOff: true },
      checks: [
        { kind: "script", target: "/Game/Tests/PT_Jump.PT_Jump", title: "Jump", links: [{ url: "https://trello.com/c/a1b2", rel: "related" }] },
        { kind: "manual", target: "Reads well on a TV", required: false },
        { kind: "automation", target: "Project.Functional.Tutorial" },
      ],
    });
    s.signOff(g.id, "octocat", "Played it");
    s.update(g.id, { archived: true });
    const files = fs.readdirSync(dir()).filter((n) => n.endsWith(".json") && n !== "goal.schema.json");
    expect(files).toHaveLength(3);
    for (const f of files) {
      const goal = JSON.parse(fs.readFileSync(path.join(dir(), f), "utf-8"));
      expect(valid(goal), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("accepts the README's example and a goal with only a title", () => {
    expect(valid(JSON.parse(goalText(EXAMPLE_GOAL)))).toBe(true);
    expect(valid({ title: "Just a title" })).toBe(true);
  });

  it("refuses a malformed goal", () => {
    const base = JSON.parse(goalText(EXAMPLE_GOAL));
    const bad = [
      { ...base, title: undefined },
      { ...base, priority: "urgent" },
      { ...base, id: "Bad Id" },
      { ...base, due: "next week" },
      { ...base, links: [{ url: "javascript:alert(1)" }] },
      { ...base, links: [{ url: "DATA:text/html,x" }] },
      { ...base, links: [{ title: "no url" }] },
      { ...base, links: [{ url: "https://x.y", label: "typo" }] },
      { ...base, checks: [{ kind: "script", target: "Game/NoSlash" }] },
      { ...base, checks: [{ kind: "nope", target: "/Game/A" }] },
      { ...base, acceptance: { stableRuns: 11 } },
      { ...base, schema: 2 },
    ];
    for (const g of bad) expect(valid(g), JSON.stringify(g).slice(0, 200)).toBe(false);
  });
});
