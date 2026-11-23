/**
 * Goals, as files in the project: <project>/QA/Goals/<id>.json, one per goal,
 * checked in with the game. Each file is pretty-printed with its keys in one
 * fixed order and a trailing newline, so a diff shows only what changed and
 * two people editing different goals never touch the same file.
 *
 * A file that does not parse, or is not a goal, is left alone and reported as
 * a warning; it never stops the others loading. The folder is watched, so a
 * goal changed by source control or a text editor shows at once.
 *
 * Beside the goals the store keeps goal.schema.json and README.md
 * (goal-docs.ts), written once the folder exists and rewritten only when
 * their text would change, so source control sees no churn. Each goal file
 * names the schema in "$schema"; a different "$schema" a file already has is
 * kept as written.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_ACCEPTANCE,
  GOAL_ID,
  HUB_GOALS_DIR,
  HUB_GOALS_README,
  HUB_GOAL_SCHEMA_FILE,
  HUB_SCHEMA,
  checkId,
  goalSlug,
  type AcceptanceRule,
  type CheckRef,
  type CheckUpdate,
  type Goal,
  type GoalDraft,
  type GoalPriority,
  type GoalUpdate,
  type SignOff,
  type TrackerLink,
} from "@ue-mcp-studio/shared";
import { writeFileAtomic } from "../atomic-write.js";
import { EXAMPLE_GOAL, GOAL_SCHEMA_REF, GOAL_SCHEMA_TEXT, goalsReadme } from "./goal-docs.js";
import { bad, checkRefOf, conflict, isObject, linksOf, notFound, readLinks } from "./util.js";

const PRIORITIES: readonly GoalPriority[] = ["p0", "p1", "p2", "p3"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How long the folder is left to settle after a change before it is read again: a checkout writes many files. */
const SETTLE_MS = 250;
/** The longest title, description and note kept. */
const MAX_TITLE = 200;
const MAX_TEXT = 20_000;

/** Top-level keys in the order a goal file is written. Unknown keys a newer Studio wrote follow, sorted. */
export const ORDER = ["schema", "id", "kind", "title", "description", "parent", "owner", "priority", "tags", "due", "links", "acceptance", "checks", "signOff", "archived", "createdAt", "updatedAt"] as const;
/** Keys a goal file holds that are not the goal's own fields, kept apart from unknown ones: "$schema" is always written first. */
const SCHEMA_KEY = "$schema";

export interface GoalStoreOptions {
  projectDir: string;
  /** The goals folder relative to the project; HUB_GOALS_DIR unless the project sets another. */
  dir?: string;
  now?: () => string;
  /** Goals changed, on disk or here. */
  changed?: (goalId?: string) => void;
  log?: { warn(message: string, detail?: unknown): void };
}

interface Entry {
  goal: Goal;
  /** What the file held when last read or written, to tell a real change from our own write coming back. */
  text: string;
  /** Keys this Studio does not know, kept as written. */
  extra: Record<string, unknown>;
}

/** Links in their written form: url, title, rel. */
const linksText = (links: TrackerLink[]): TrackerLink[] => links.map((l) => ({ url: l.url, ...(l.title !== undefined ? { title: l.title } : {}), ...(l.rel !== undefined ? { rel: l.rel } : {}) }));

/** A goal file's text: "$schema" first, then a fixed key order, two-space indent, trailing newline. */
export function goalText(goal: Goal, extra: Record<string, unknown> = {}): string {
  const out: Record<string, unknown> = { [SCHEMA_KEY]: extra[SCHEMA_KEY] !== undefined ? extra[SCHEMA_KEY] : GOAL_SCHEMA_REF };
  const g = goal as unknown as Record<string, unknown>;
  for (const k of ORDER) {
    const v = g[k];
    if (v === undefined) continue;
    if (k === "acceptance") {
      const a = v as AcceptanceRule;
      out[k] = { stableRuns: a.stableRuns, staleAfterDays: a.staleAfterDays, signOff: a.signOff };
    } else if (k === "links") {
      if ((v as TrackerLink[]).length) out[k] = linksText(v as TrackerLink[]);
    } else if (k === "checks") {
      out[k] = (v as CheckRef[]).map((c) => ({
        kind: c.kind,
        target: c.target,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.required !== undefined ? { required: c.required } : {}),
        ...(c.links?.length ? { links: linksText(c.links) } : {}),
      }));
    } else if (k === "signOff" && v) {
      const s = v as SignOff;
      out[k] = { by: s.by, at: s.at, ...(s.note !== undefined ? { note: s.note } : {}) };
    } else {
      out[k] = v;
    }
  }
  for (const k of Object.keys(extra).sort()) if (k !== SCHEMA_KEY && !(ORDER as readonly string[]).includes(k)) out[k] = extra[k];
  return `${JSON.stringify(out, null, 2)}\n`;
}

function acceptanceOf(v: unknown, fallback: AcceptanceRule = DEFAULT_ACCEPTANCE): AcceptanceRule {
  const o = isObject(v) ? v : {};
  const runs = Number(o.stableRuns);
  const days = o.staleAfterDays;
  return {
    stableRuns: Number.isInteger(runs) && runs >= 1 && runs <= 10 ? runs : fallback.stableRuns,
    staleAfterDays: days === null ? null : typeof days === "number" && Number.isFinite(days) && days > 0 ? days : fallback.staleAfterDays,
    signOff: typeof o.signOff === "boolean" ? o.signOff : fallback.signOff,
  };
}

/** Checks without duplicates, the first of each id kept. */
function uniqueChecks(checks: CheckRef[]): CheckRef[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    const id = checkId(c);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const str = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * A goal from a file's JSON, with what was wrong in it. Null with a problem
 * when it is no goal at all; fields of the wrong type are dropped and named.
 */
export function parseGoal(raw: unknown, fileId: string, fallbackTime: string): { goal: Goal; extra: Record<string, unknown>; problems: string[] } | { problem: string } {
  if (!isObject(raw)) return { problem: "it is not a JSON object" };
  if (typeof raw.schema === "number" && raw.schema > HUB_SCHEMA) return { problem: `it was written by a newer Studio (schema ${raw.schema})` };
  if (raw.id !== undefined && raw.id !== fileId) return { problem: `its id "${String(raw.id)}" is not its file name` };
  const title = str(raw.title, MAX_TITLE);
  if (!title) return { problem: "it has no title" };
  const problems: string[] = [];
  const checks: CheckRef[] = [];
  if (raw.checks !== undefined && !Array.isArray(raw.checks)) problems.push("checks is not a list");
  for (const [i, c] of (Array.isArray(raw.checks) ? raw.checks : []).entries()) {
    const ref = checkRefOf(c);
    if (!ref) {
      problems.push(`check ${i + 1} is not a check`);
      continue;
    }
    checks.push(ref);
    for (const p of readLinks((c as Record<string, unknown>).links).problems) problems.push(`check ${i + 1} ${p}`);
  }
  const goalLinks = readLinks(raw.links);
  problems.push(...goalLinks.problems);
  const kind = raw.kind === "milestone" ? "milestone" : "goal";
  const signOff = isObject(raw.signOff) && typeof raw.signOff.by === "string" && typeof raw.signOff.at === "string"
    ? { by: raw.signOff.by, at: raw.signOff.at, ...(typeof raw.signOff.note === "string" ? { note: raw.signOff.note } : {}) }
    : null;
  const goal: Goal = {
    schema: HUB_SCHEMA,
    id: fileId,
    kind,
    title,
    ...(str(raw.description) ? { description: str(raw.description) } : {}),
    ...(kind === "goal" && typeof raw.parent === "string" && GOAL_ID.test(raw.parent) ? { parent: raw.parent } : {}),
    ...(str(raw.owner, MAX_TITLE) ? { owner: str(raw.owner, MAX_TITLE) } : {}),
    ...(PRIORITIES.includes(raw.priority as GoalPriority) ? { priority: raw.priority as GoalPriority } : {}),
    ...(Array.isArray(raw.tags) ? { tags: [...new Set(raw.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()))] } : {}),
    ...(typeof raw.due === "string" && DATE.test(raw.due) ? { due: raw.due } : {}),
    ...(goalLinks.links.length ? { links: goalLinks.links } : {}),
    acceptance: acceptanceOf(raw.acceptance),
    checks: uniqueChecks(checks),
    ...(signOff ? { signOff } : {}),
    ...(raw.archived === true ? { archived: true } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : fallbackTime,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : fallbackTime,
  };
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !(ORDER as readonly string[]).includes(k)));
  return { goal, extra, problems };
}

export class GoalStore {
  private readonly goals = new Map<string, Entry>();
  private problems: string[] = [];
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => string;
  readonly dir: string;
  readonly relDir: string;

  constructor(private readonly o: GoalStoreOptions) {
    this.now = o.now ?? (() => new Date().toISOString());
    this.relDir = (o.dir ?? HUB_GOALS_DIR).replace(/\\/g, "/");
    this.dir = path.resolve(o.projectDir, this.relDir);
    this.read();
    if (fs.existsSync(this.dir)) this.writeDocs();
  }

  /**
   * goal.schema.json and README.md, each written only when its text differs
   * from what the file holds. A failure is logged: the goals still work.
   */
  writeDocs(): void {
    const docs: Array<[string, string]> = [
      [HUB_GOAL_SCHEMA_FILE, GOAL_SCHEMA_TEXT],
      [HUB_GOALS_README, goalsReadme(goalText(EXAMPLE_GOAL))],
    ];
    for (const [name, text] of docs) {
      const file = path.join(this.dir, name);
      try {
        let had: string | null = null;
        try {
          had = fs.readFileSync(file, "utf-8");
        } catch {
          // Not there yet.
        }
        // A checkout may turn the newlines into CRLF: that is the same text.
        if (had !== null && had.replace(/\r\n/g, "\n") === text) continue;
        writeFileAtomic(file, text);
      } catch (e) {
        this.o.log?.warn(`hub: ${this.relDir}/${name} could not be written`, e);
      }
    }
  }

  /** Start following the folder; a missing folder is followed from the first goal written into it. */
  watch(): void {
    if (this.watcher || !fs.existsSync(this.dir)) return;
    try {
      this.watcher = fs.watch(this.dir, (_event, name) => {
        if (name && !String(name).toLowerCase().endsWith(".json")) return;
        this.settle();
      });
      this.watcher.on("error", () => this.unwatch());
      this.watcher.unref?.();
    } catch (e) {
      this.o.log?.warn("hub: the goals folder cannot be watched", e);
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  dispose(): void {
    this.unwatch();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private settle(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, SETTLE_MS);
    this.timer.unref?.();
  }

  /** Read the folder again, and say so when anything differs from what was held. Returns whether it did. */
  refresh(): boolean {
    const before = new Map([...this.goals].map(([id, e]) => [id, e.text]));
    const problemsBefore = this.problems.join("\n");
    this.read();
    const ids = new Set([...before.keys(), ...this.goals.keys()]);
    const changed = [...ids].filter((id) => before.get(id) !== this.goals.get(id)?.text);
    if (changed.length === 0 && problemsBefore === this.problems.join("\n")) return false;
    this.o.changed?.(changed.length === 1 ? changed[0] : undefined);
    if (!this.watcher) this.watch();
    return true;
  }

  private read(): void {
    this.goals.clear();
    this.problems = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.toLowerCase().endsWith(".json") && n.toLowerCase() !== HUB_GOAL_SCHEMA_FILE);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const id = name.slice(0, -".json".length);
      const where = `${this.relDir}/${name}`;
      if (!GOAL_ID.test(id)) {
        this.problems.push(`${where}: a goal's file name is its id, lowercase letters, digits and dashes`);
        continue;
      }
      const file = path.join(this.dir, name);
      let text: string;
      let mtime: string;
      try {
        text = fs.readFileSync(file, "utf-8");
        mtime = fs.statSync(file).mtime.toISOString();
      } catch {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text.replace(/^﻿/, ""));
      } catch (e) {
        this.problems.push(`${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const p = parseGoal(raw, id, mtime);
      if ("problem" in p) {
        this.problems.push(`${where} was not loaded: ${p.problem}`);
        continue;
      }
      for (const problem of p.problems) this.problems.push(`${where}: ${problem}, so it was left out`);
      this.goals.set(id, { goal: p.goal, text, extra: p.extra });
    }
    // A parent that is gone or is no milestone is reported, and the goal shows on its own.
    for (const { goal } of this.goals.values()) {
      if (!goal.parent) continue;
      const parent = this.goals.get(goal.parent)?.goal;
      if (!parent || parent.kind !== "milestone") this.problems.push(`${this.relDir}/${goal.id}.json: its parent "${goal.parent}" is not a milestone here`);
    }
  }

  list(): Goal[] {
    return [...this.goals.values()].map((e) => e.goal);
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id)?.goal;
  }

  warnings(): string[] {
    return [...this.problems];
  }

  /** The goal file's path. */
  fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** The goal file's text as last read or written, or null for a goal not held. */
  textOf(id: string): string | null {
    return this.goals.get(id)?.text ?? null;
  }

  /** The text a goal would be written as, keeping the file's unknown keys. */
  textFor(goal: Goal): string {
    return goalText(goal, this.goals.get(goal.id)?.extra ?? {});
  }

  private write(goal: Goal, extra: Record<string, unknown> = this.goals.get(goal.id)?.extra ?? {}): Goal {
    const text = goalText(goal, extra);
    const fresh = !fs.existsSync(this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    if (fresh || this.goals.size === 0) this.writeDocs();
    writeFileAtomic(this.fileOf(goal.id), text);
    this.goals.set(goal.id, { goal, text, extra });
    this.watch();
    this.o.changed?.(goal.id);
    return goal;
  }

  private require(id: string): Goal {
    const g = this.goals.get(id)?.goal;
    if (!g) throw notFound(`no goal ${id}`);
    return g;
  }

  /** A unique id: the asked one when free, else the title's slug with -2, -3 and so on. */
  private freshId(asked: unknown, title: string): string {
    if (typeof asked === "string" && asked) {
      if (!GOAL_ID.test(asked)) throw bad("id must be lowercase letters, digits and dashes, at most 64 characters");
      if (this.goals.has(asked) || fs.existsSync(path.join(this.dir, `${asked}.json`))) throw conflict(`a goal ${asked} already exists`);
      return asked;
    }
    const base = goalSlug(title);
    const taken = (id: string) => this.goals.has(id) || fs.existsSync(path.join(this.dir, `${id}.json`));
    if (!taken(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const id = `${base.slice(0, 64 - suffix.length).replace(/-+$/, "")}${suffix}`;
      if (!taken(id)) return id;
    }
  }

  /** Check the fields a draft or update gives, and return them normalized. Throws a 400 for any that is wrong. */
  private fields(u: Record<string, unknown>, id: string | null, kind: Goal["kind"]): Partial<Goal> {
    const out: Partial<Goal> = {};
    if (u.title !== undefined) {
      const t = str(u.title, MAX_TITLE);
      if (!t) throw bad("title must be a non-empty string");
      out.title = t;
    }
    if (u.description !== undefined) {
      if (u.description !== null && typeof u.description !== "string") throw bad("description must be a string");
      out.description = str(u.description);
    }
    if (u.owner !== undefined) {
      if (u.owner !== null && typeof u.owner !== "string") throw bad("owner must be a string or null");
      out.owner = str(u.owner, MAX_TITLE) ?? null;
    }
    if (u.priority !== undefined) {
      if (!PRIORITIES.includes(u.priority as GoalPriority)) throw bad(`priority must be one of ${PRIORITIES.join(", ")}`);
      out.priority = u.priority as GoalPriority;
    }
    if (u.tags !== undefined) {
      if (!Array.isArray(u.tags) || u.tags.some((t) => typeof t !== "string")) throw bad("tags must be a list of strings");
      out.tags = [...new Set((u.tags as string[]).map((t) => t.trim()).filter(Boolean))];
    }
    if (u.due !== undefined) {
      if (u.due !== null && (typeof u.due !== "string" || !DATE.test(u.due))) throw bad("due must be a date, YYYY-MM-DD, or null");
      out.due = (u.due as string | null) ?? null;
    }
    if (u.acceptance !== undefined) {
      if (!isObject(u.acceptance)) throw bad("acceptance must be an object");
      const a = u.acceptance;
      if (a.stableRuns !== undefined && !(Number.isInteger(a.stableRuns) && (a.stableRuns as number) >= 1 && (a.stableRuns as number) <= 10)) throw bad("acceptance.stableRuns must be a whole number from 1 to 10");
      if (a.staleAfterDays !== undefined && a.staleAfterDays !== null && !(typeof a.staleAfterDays === "number" && a.staleAfterDays > 0)) throw bad("acceptance.staleAfterDays must be a number of days, or null");
      if (a.signOff !== undefined && typeof a.signOff !== "boolean") throw bad("acceptance.signOff must be a boolean");
      out.acceptance = acceptanceOf(a, id ? this.get(id)?.acceptance : DEFAULT_ACCEPTANCE);
    }
    if (u.checks !== undefined) out.checks = this.checksOf(u.checks);
    if (u.links !== undefined) out.links = u.links === null ? [] : linksOf(u.links);
    if (u.archived !== undefined) {
      if (typeof u.archived !== "boolean") throw bad("archived must be a boolean");
      out.archived = u.archived;
    }
    if (u.parent !== undefined) {
      if (u.parent !== null && typeof u.parent !== "string") throw bad("parent must be a milestone's id, or null");
      const parent = (u.parent as string | null) || null;
      if (parent) {
        if (kind === "milestone") throw bad("a milestone has no parent: goals nest one level");
        if (parent === id) throw bad("a goal cannot be its own parent");
        const p = this.get(parent);
        if (!p) throw bad(`no milestone ${parent}`);
        if (p.kind !== "milestone") throw bad(`${parent} is a goal, not a milestone`);
      }
      out.parent = parent;
    }
    return out;
  }

  private checksOf(v: unknown): CheckRef[] {
    if (!Array.isArray(v)) throw bad("checks must be a list of { kind, target }");
    return uniqueChecks(v.map((c, i) => {
      const ref = checkRefOf(c);
      if (!ref) throw bad(`check ${i + 1} must be { kind: script | uat | repro | automation | manual, target }, a script's target an asset path`);
      // checkRefOf keeps the valid links; a request is refused for any that is not.
      const raw = (c as Record<string, unknown>).links;
      if (raw !== undefined && raw !== null) linksOf(raw, `check ${i + 1} links`);
      return ref;
    }));
  }

  create(draft: unknown): Goal {
    return this.write(this.planCreate(draft), {});
  }

  /** The goal create() would write, without writing it. */
  planCreate(draft: unknown): Goal {
    if (!isObject(draft)) throw bad("body must be a goal: { title, ... }");
    const d = draft as Partial<GoalDraft> & Record<string, unknown>;
    if (!str(d.title, MAX_TITLE)) throw bad("title must be a non-empty string");
    if (d.kind !== undefined && d.kind !== "goal" && d.kind !== "milestone") throw bad("kind must be goal or milestone");
    const kind = d.kind ?? "goal";
    const f = this.fields(d, null, kind);
    const id = this.freshId(d.id, f.title!);
    const at = this.now();
    const goal: Goal = {
      schema: HUB_SCHEMA,
      id,
      kind,
      title: f.title!,
      ...(f.description ? { description: f.description } : {}),
      ...(f.parent ? { parent: f.parent } : {}),
      ...(f.owner ? { owner: f.owner } : {}),
      ...(f.priority ? { priority: f.priority } : {}),
      ...(f.tags?.length ? { tags: f.tags } : {}),
      ...(f.due ? { due: f.due } : {}),
      ...(f.links?.length ? { links: f.links } : {}),
      acceptance: f.acceptance ?? { ...DEFAULT_ACCEPTANCE },
      checks: f.checks ?? [],
      ...(f.archived ? { archived: true } : {}),
      createdAt: at,
      updatedAt: at,
    };
    return goal;
  }

  update(id: string, u: unknown): Goal {
    return this.write(this.planUpdate(id, u));
  }

  /** The goal update() would write, without writing it. */
  planUpdate(id: string, u: unknown): Goal {
    const had = this.require(id);
    if (!isObject(u)) throw bad("body must be the fields to change");
    const upd = u as GoalUpdate & Record<string, unknown>;
    if (upd.kind !== undefined && upd.kind !== "goal" && upd.kind !== "milestone") throw bad("kind must be goal or milestone");
    if (upd.signOff !== undefined) throw bad("sign-off is given and cleared with /sign-off");
    const kind = upd.kind ?? had.kind;
    if (kind === "goal" && had.kind === "milestone" && this.children(id).length > 0) throw conflict("the milestone has goals: move them out first");
    const f = this.fields(upd, id, kind);
    if (kind === "milestone" && (f.parent !== undefined ? f.parent : had.parent)) throw bad("a goal in a milestone cannot become a milestone: clear its parent too");
    const next: Goal = { ...had, ...f, kind, schema: HUB_SCHEMA, id, createdAt: had.createdAt, updatedAt: this.now() };
    return clean(next);
  }

  updateCheck(id: string, check: string, u: unknown): Goal {
    return this.write(this.planUpdateCheck(id, check, u));
  }

  /** One check of a goal with its title, required or links changed (CheckUpdate), without writing it. */
  planUpdateCheck(id: string, check: string, u: unknown): Goal {
    const had = this.require(id);
    const at = had.checks.findIndex((c) => checkId(c) === check);
    if (at < 0) throw notFound(`goal ${id} has no check ${check}`);
    if (!isObject(u)) throw bad("body must be { title?, required?, links? }");
    const upd = u as CheckUpdate & Record<string, unknown>;
    const next: CheckRef = { ...had.checks[at] };
    if (upd.title !== undefined) {
      if (upd.title !== null && typeof upd.title !== "string") throw bad("title must be a string, or null to clear it");
      const t = str(upd.title, MAX_TITLE);
      if (t) next.title = t;
      else delete next.title;
    }
    if (upd.required !== undefined) {
      if (typeof upd.required !== "boolean") throw bad("required must be a boolean");
      if (upd.required) delete next.required;
      else next.required = false;
    }
    if (upd.links !== undefined) {
      const links = upd.links === null ? [] : linksOf(upd.links);
      if (links.length) next.links = links;
      else delete next.links;
    }
    const checks = had.checks.slice();
    checks[at] = next;
    return { ...had, checks, updatedAt: this.now() };
  }

  /** The goals in a milestone. */
  children(id: string): Goal[] {
    return this.list().filter((g) => g.parent === id);
  }

  delete(id: string): void {
    this.require(id);
    // Goals in a deleted milestone stay, on their own.
    for (const child of this.children(id)) this.write(clean({ ...child, parent: null, updatedAt: this.now() }));
    try {
      fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    } finally {
      this.goals.delete(id);
      this.o.changed?.(id);
    }
  }

  addChecks(id: string, checks: unknown): Goal {
    const had = this.require(id);
    const add = this.checksOf(checks);
    if (add.length === 0) throw bad("body must be { checks: [{ kind, target }] } with at least one check");
    const known = new Set(had.checks.map(checkId));
    const fresh = add.filter((c) => !known.has(checkId(c)));
    if (fresh.length === 0) return had;
    return this.write({ ...had, checks: [...had.checks, ...fresh], updatedAt: this.now() });
  }

  removeCheck(id: string, check: string): Goal {
    const had = this.require(id);
    const checks = had.checks.filter((c) => checkId(c) !== check);
    if (checks.length === had.checks.length) throw notFound(`goal ${id} has no check ${check}`);
    return this.write({ ...had, checks, updatedAt: this.now() });
  }

  signOff(id: string, by: string, note?: unknown): Goal {
    const had = this.require(id);
    if (note !== undefined && typeof note !== "string") throw bad("note must be a string");
    const n = str(note);
    return this.write({ ...had, signOff: { by, at: this.now(), ...(n ? { note: n } : {}) }, updatedAt: this.now() });
  }

  clearSignOff(id: string): Goal {
    const had = this.require(id);
    if (!had.signOff) return had;
    return this.write(clean({ ...had, signOff: null, updatedAt: this.now() }));
  }
}

/** A goal without empty optional fields, so the file stays as short as the goal is. */
function clean(g: Goal): Goal {
  const out = { ...g } as Record<string, unknown>;
  for (const k of ["description", "parent", "owner", "due", "signOff"]) if (out[k] === null || out[k] === undefined || out[k] === "") delete out[k];
  if (Array.isArray(out.tags) && out.tags.length === 0) delete out.tags;
  if (Array.isArray(out.links) && out.links.length === 0) delete out.links;
  if (out.archived === false) delete out.archived;
  return out as unknown as Goal;
}
