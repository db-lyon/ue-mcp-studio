/**
 * Goals, as files in the project: <project>/QA/Goals/<id>.json, one per goal,
 * checked in with the game. Studio writes a file only when a person or an
 * agent changed that goal, and then patches it: the members the change
 * touched are replaced and everything else is written back as read, in its
 * place, including fields and list entries this Studio does not know. A new
 * file is pretty-printed with its keys in one fixed order and a trailing
 * newline; a file's line endings are kept. Nothing in a goal file changes
 * with time, so two people editing different fields of one goal merge
 * cleanly.
 *
 * Every write goes through the project's source control (vcs.ts
 * projectWriter): under Perforce a goal is opened for edit, added or deleted
 * there, and a refusal is reported before anything changes.
 *
 * A file that does not parse, has merge conflict markers, or is not a goal is
 * left alone and reported as a warning naming it; it never stops the others
 * loading. The folder is watched, so a goal changed by source control or a
 * text editor shows at once.
 *
 * goal.schema.json and README.md (goal-docs.ts) are written when a goal is
 * created and they are not there, and never again: after that they are the
 * team's.
 *
 * Goals require goals (Goal.requires), held in the requiring goal's file. A
 * file from before that names its milestone in "parent" is read as an entry
 * in the parent's requires. The entry is written when the parent's file is
 * saved for another reason, and "parent" is dropped when the old file is
 * saved after that, or at once when the parent stops requiring it. A change
 * that would make goals require each other in a loop is refused; a loop
 * already in the files is reported.
 */
import { createHash, randomBytes } from "node:crypto";
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
  goalLoops,
  goalSlug,
  loopIfRequired,
  requiresOf,
  trackerLinkOf,
  type AcceptanceRule,
  type CheckRef,
  type CheckUpdate,
  type Goal,
  type GoalDraft,
  type GoalPriority,
  type GoalRequirement,
  type GoalUpdate,
  type TrackerLink,
} from "@ue-mcp-studio/shared";
import { projectWriter, type ProjectWriter } from "../vcs.js";
import { EXAMPLE_GOAL, GOAL_SCHEMA_REF, GOAL_SCHEMA_TEXT, goalsReadme } from "./goal-docs.js";
import { bad, checkRefOf, conflict, isObject, linksOf, notFound, readLinks } from "./util.js";

const PRIORITIES: readonly GoalPriority[] = ["p0", "p1", "p2", "p3"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How long the folder is left to settle after a change before it is read again: a checkout writes many files. */
const SETTLE_MS = 250;
/** The longest title, description and note kept. */
const MAX_TITLE = 200;
const MAX_TEXT = 20_000;
/** A new id's random ending: four base-36 characters after a dash. */
const SUFFIX = 4;
/** A line git or Perforce leaves where a merge conflicted. */
const CONFLICT_MARKER = /^(<{7}|>{7}|={7})(\s|$)/m;

/** Top-level keys in the order a new goal file is written, and where a key a file gains goes. */
export const ORDER = ["schema", "id", "kind", "title", "description", "owner", "priority", "tags", "due", "links", "acceptance", "requires", "checks", "archived"] as const;
/** Keys an older Studio wrote that this one no longer writes: "parent" became an entry in the parent's requires. */
const LEGACY_PARENT = "parent";
/** A loop in words: "a > b > a". */
const loopText = (path: string[]): string => path.join(" > ");

export interface GoalStoreOptions {
  projectDir: string;
  /** The goals folder relative to the project; HUB_GOALS_DIR unless the project sets another. */
  dir?: string;
  /** Goals changed, on disk or here. */
  changed?: (goalId?: string) => void;
  log?: { warn(message: string, detail?: unknown): void };
  /** How project files are written; through the project's source control unless a test gives another. */
  writer?: ProjectWriter;
}

interface Entry {
  /** The goal, with the entries older files' "parent" adds to its requires. */
  goal: Goal;
  /** The goal as its file states it. */
  file: Goal;
  /** The file's JSON as read, every member in its place. */
  raw: Record<string, unknown>;
  /** What the file held when last read, to tell a real change from our own write coming back. */
  text: string;
  /** The "parent" the file still holds from an older Studio. */
  legacyParent?: string;
}

/** Links in their written form: url, title, rel. */
const linksText = (links: TrackerLink[]): TrackerLink[] => links.map((l) => ({ url: l.url, ...(l.title !== undefined ? { title: l.title } : {}), ...(l.rel !== undefined ? { rel: l.rel } : {}) }));

/** A goal's members as Studio writes them, in ORDER; what a patch compares and writes. */
export function goalFields(goal: Goal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const g = goal as unknown as Record<string, unknown>;
  for (const k of ORDER) {
    const v = g[k];
    if (v === undefined || v === null) continue;
    if (k === "acceptance") {
      const a = v as AcceptanceRule;
      out[k] = { stableRuns: a.stableRuns, staleAfterDays: a.staleAfterDays, signOff: a.signOff };
    } else if (k === "links" || k === "tags") {
      if ((v as unknown[]).length) out[k] = k === "links" ? linksText(v as TrackerLink[]) : v;
    } else if (k === "requires") {
      if ((v as GoalRequirement[]).length) out[k] = (v as GoalRequirement[]).map((r) => ({ goal: r.goal, ...(r.required === false ? { required: false } : {}) }));
    } else if (k === "checks") {
      out[k] = (v as CheckRef[]).map((c) => ({
        kind: c.kind,
        target: c.target,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.required !== undefined ? { required: c.required } : {}),
        ...(c.links?.length ? { links: linksText(c.links) } : {}),
      }));
    } else {
      out[k] = v;
    }
  }
  return out;
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** A new goal file's text: "$schema" first, then ORDER, two-space indent, trailing newline. */
export function goalText(goal: Goal): string {
  return json({ $schema: GOAL_SCHEMA_REF, ...goalFields(goal) });
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** An entry's identity in a goal file's list: a check by kind and target, a required goal by id, a link by URL, a tag by itself. */
function itemKey(v: unknown): string | null {
  if (typeof v === "string") return `tag:${v.trim()}`;
  if (!isObject(v)) return null;
  if (typeof v.kind === "string" && typeof v.target === "string") {
    const ref = checkRefOf(v);
    return ref ? checkId(ref) : `${v.kind}:${v.target}`;
  }
  if (typeof v.goal === "string") return `goal:${v.goal}`;
  if (typeof v.url === "string") {
    const l = trackerLinkOf(v);
    return `url:${"link" in l ? l.link.url : v.url}`;
  }
  return null;
}

/** An object with `key` added where `order` puts it among the keys it has, else at the end. */
function withKey(obj: Record<string, unknown>, key: string, value: unknown, order?: readonly string[]): Record<string, unknown> {
  const entries = Object.entries(obj);
  const at = order ? order.indexOf(key) : -1;
  const i = at < 0 ? -1 : entries.findIndex(([k]) => order!.indexOf(k) > at);
  if (i < 0) entries.push([key, value]);
  else entries.splice(i, 0, [key, value]);
  return Object.fromEntries(entries);
}

/**
 * `raw` changed as `before` became `after`, touching nothing else: members
 * equal in both are written back as read, a changed object is patched member
 * by member and a changed list entry by entry (patchList).
 */
export function patchJson(raw: unknown, before: unknown, after: unknown, order?: readonly string[]): unknown {
  if (same(before, after)) return raw;
  if (isObject(after) && isObject(raw)) {
    const was = isObject(before) ? before : {};
    let out: Record<string, unknown> = { ...raw };
    for (const k of new Set([...Object.keys(was), ...Object.keys(after)])) {
      if (same(was[k], after[k])) continue;
      if (after[k] === undefined) delete out[k];
      else if (k in out) out[k] = patchJson(raw[k], was[k], after[k]);
      // A member the file leaves to its default gains only what changed of it.
      else out = withKey(out, k, isObject(was[k]) ? patchJson({}, was[k], after[k]) : after[k], order);
    }
    return out;
  }
  if (Array.isArray(after) && Array.isArray(raw)) return patchList(raw, Array.isArray(before) ? before : [], after);
  return after;
}

/**
 * A list as `after` orders it, each entry patched from the one the file has
 * for it. Entries this Studio could not read (in the file, never in
 * `before`) stay, after the entry they followed.
 */
function patchList(raw: unknown[], before: unknown[], after: unknown[]): unknown[] {
  const known = new Set(before.map(itemKey));
  const placed = new Map<number, unknown>();
  const out = after.map((a) => {
    const key = itemKey(a);
    const i = key === null ? -1 : raw.findIndex((r, n) => !placed.has(n) && itemKey(r) === key);
    if (i < 0) return a;
    const v = patchJson(raw[i], before.find((b) => itemKey(b) === key) ?? {}, a);
    placed.set(i, v);
    return v;
  });
  let anchor: unknown;
  let anchored = false;
  for (const [n, r] of raw.entries()) {
    if (placed.has(n)) {
      anchor = placed.get(n);
      anchored = true;
      continue;
    }
    const key = itemKey(r);
    if (key !== null && known.has(key)) continue;
    const at = anchored ? out.indexOf(anchor) + 1 : 0;
    out.splice(at, 0, r);
    anchor = r;
    anchored = true;
  }
  return out;
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
 * when it is no goal at all; fields of the wrong type are left out of the
 * goal and named, and stay in the file.
 */
export function parseGoal(raw: unknown, fileId: string): { goal: Goal; problems: string[]; legacyParent?: string } | { problem: string } {
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
      problems.push(`check ${i + 1} is not a check this Studio knows`);
      continue;
    }
    checks.push(ref);
    for (const p of readLinks((c as Record<string, unknown>).links).problems) problems.push(`check ${i + 1} ${p}`);
  }
  const goalLinks = readLinks(raw.links);
  problems.push(...goalLinks.problems);
  const requires: GoalRequirement[] = [];
  if (raw.requires !== undefined && !Array.isArray(raw.requires)) problems.push("requires is not a list");
  for (const [i, r] of (Array.isArray(raw.requires) ? raw.requires : []).entries()) {
    const id = isObject(r) ? r.goal : undefined;
    if (typeof id !== "string" || !GOAL_ID.test(id)) {
      problems.push(`required goal ${i + 1} is not { goal: id }`);
      continue;
    }
    if (id === fileId) {
      problems.push("it requires itself");
      continue;
    }
    if (requires.some((x) => x.goal === id)) continue;
    requires.push({ goal: id, ...((r as Record<string, unknown>).required === false ? { required: false } : {}) });
  }
  const parent = raw[LEGACY_PARENT];
  const legacyParent = typeof parent === "string" && GOAL_ID.test(parent) && parent !== fileId ? parent : undefined;
  const goal: Goal = {
    schema: HUB_SCHEMA,
    id: fileId,
    kind: raw.kind === "milestone" ? "milestone" : "goal",
    title,
    ...(str(raw.description) ? { description: str(raw.description) } : {}),
    ...(str(raw.owner, MAX_TITLE) ? { owner: str(raw.owner, MAX_TITLE) } : {}),
    ...(PRIORITIES.includes(raw.priority as GoalPriority) ? { priority: raw.priority as GoalPriority } : {}),
    ...(Array.isArray(raw.tags) ? { tags: [...new Set(raw.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()))] } : {}),
    ...(typeof raw.due === "string" && DATE.test(raw.due) ? { due: raw.due } : {}),
    ...(goalLinks.links.length ? { links: goalLinks.links } : {}),
    acceptance: acceptanceOf(raw.acceptance),
    ...(requires.length ? { requires } : {}),
    checks: uniqueChecks(checks),
    ...(raw.archived === true ? { archived: true } : {}),
  };
  return { goal, problems, ...(legacyParent ? { legacyParent } : {}) };
}

export class GoalStore {
  private readonly goals = new Map<string, Entry>();
  private problems: string[] = [];
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly writer: ProjectWriter;
  /** Seeds new ids' endings: random for each store, so ids made on two machines differ, and the same for one draft, so a create writes the id its preview showed. */
  private readonly salt = randomBytes(16);
  readonly dir: string;
  readonly relDir: string;

  constructor(private readonly o: GoalStoreOptions) {
    this.writer = o.writer ?? projectWriter();
    this.relDir = (o.dir ?? HUB_GOALS_DIR).replace(/\\/g, "/");
    this.dir = path.resolve(o.projectDir, this.relDir);
    this.read();
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
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.dir, name), "utf-8");
      } catch {
        continue;
      }
      if (CONFLICT_MARKER.test(text)) {
        this.problems.push(`${where} has merge conflict markers, so it is left out until the conflict is resolved`);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text.replace(/^﻿/, ""));
      } catch (e) {
        this.problems.push(`${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const p = parseGoal(raw, id);
      if ("problem" in p) {
        this.problems.push(`${where} was not loaded: ${p.problem}`);
        continue;
      }
      for (const problem of p.problems) this.problems.push(`${where}: ${problem}, so it was left out`);
      this.goals.set(id, { goal: p.goal, file: p.goal, raw: raw as Record<string, unknown>, text, ...(p.legacyParent ? { legacyParent: p.legacyParent } : {}) });
    }
    // An older file's "parent" is an entry at the end of the parent's requires, files taken in name order so the same files read the same way.
    for (const [id, e] of this.goals) {
      if (!e.legacyParent) continue;
      const parent = this.goals.get(e.legacyParent);
      if (!parent) {
        this.problems.push(`${this.relDir}/${id}.json: its parent "${e.legacyParent}" is not here`);
        continue;
      }
      const reqs = requiresOf(parent.goal);
      if (!reqs.some((r) => r.goal === id)) parent.goal = { ...parent.goal, requires: [...reqs, { goal: id }] };
    }
    for (const { goal } of this.goals.values()) {
      for (const r of requiresOf(goal)) if (!this.goals.has(r.goal)) this.problems.push(`${this.relDir}/${goal.id}.json: it requires "${r.goal}", which is not here`);
    }
    // A loop counts once around for status and is reported here.
    for (const cycle of goalLoops(this.list()).cycles) this.problems.push(`${this.relDir}: goals require each other in a loop (${loopText(cycle)}), so the last step is left out of their status`);
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

  /** The text a goal would be written as: its file patched with the change, or a new file. */
  textFor(goal: Goal): string {
    return this.render(goal, new Map([[goal.id, goal]]));
  }

  /**
   * A goal's file text with `goal` written into it. `batch` is every goal
   * written with it, for an older file's "parent": dropped once the parent's
   * file lists the goal, or once the parent no longer requires it.
   */
  private render(goal: Goal, batch: ReadonlyMap<string, Goal>): string {
    const e = this.goals.get(goal.id);
    if (!e) return goalText(goal);
    const raw = patchJson(e.raw, goalFields(e.file), goalFields(goal), ORDER) as Record<string, unknown>;
    if (e.legacyParent && LEGACY_PARENT in raw) {
      const listed = (g: Pick<Goal, "requires"> | undefined): boolean => !!g && requiresOf(g).some((r) => r.goal === goal.id);
      const parent = batch.get(e.legacyParent);
      const required = listed(parent ?? this.goals.get(e.legacyParent)?.goal);
      const inFile = parent ? listed(parent) : listed(this.goals.get(e.legacyParent)?.file);
      if (!required || inFile) delete raw[LEGACY_PARENT];
    }
    const text = json(raw);
    return e.text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
  }

  /**
   * Write goals: each file whose text changes, through source control, and
   * an older file whose "parent" names one of them that no longer requires
   * it, so the requirement does not come back when it is read.
   */
  private async write(goals: Goal[]): Promise<void> {
    const batch = new Map(goals.map((g) => [g.id, g]));
    for (const [id, e] of this.goals) {
      const parent = e.legacyParent ? batch.get(e.legacyParent) : undefined;
      if (parent && !batch.has(id) && !requiresOf(parent).some((r) => r.goal === id)) batch.set(id, e.goal);
    }
    const texts = [...batch.values()].map((g) => ({ id: g.id, text: this.render(g, batch) }));
    fs.mkdirSync(this.dir, { recursive: true });
    const written: string[] = [];
    try {
      for (const { id, text } of texts) {
        if (text === this.goals.get(id)?.text) continue;
        await this.writer.write(this.fileOf(id), text);
        written.push(id);
      }
    } finally {
      if (written.length) {
        this.read();
        this.watch();
        for (const id of written) this.o.changed?.(id);
      }
    }
  }

  /** goal.schema.json and README.md, each written only when it is not there. */
  private async writeMissingDocs(): Promise<void> {
    const docs: Array<[string, () => string]> = [
      [HUB_GOAL_SCHEMA_FILE, () => GOAL_SCHEMA_TEXT],
      [HUB_GOALS_README, () => goalsReadme(goalText(EXAMPLE_GOAL))],
    ];
    for (const [name, text] of docs) {
      const file = path.join(this.dir, name);
      if (fs.existsSync(file)) continue;
      try {
        await this.writer.write(file, text());
      } catch (e) {
        this.o.log?.warn(`hub: ${this.relDir}/${name} could not be written`, e);
      }
    }
  }

  private must(id: string): Goal {
    const g = this.goals.get(id)?.goal;
    if (!g) throw notFound(`no goal ${id}`);
    return g;
  }

  /**
   * A unique id: the asked one when free, else the title's slug and a dash
   * with SUFFIX base-36 characters drawn from this store's salt and the
   * draft, so the same draft gets the same id until it is written.
   */
  private freshId(asked: unknown, title: string, draft: unknown): string {
    const taken = (id: string) => this.goals.has(id) || fs.existsSync(this.fileOf(id));
    if (typeof asked === "string" && asked) {
      if (!GOAL_ID.test(asked)) throw bad("id must be lowercase letters, digits and dashes, at most 64 characters");
      if (taken(asked)) throw conflict(`a goal ${asked} already exists`);
      return asked;
    }
    const base = goalSlug(title, 64 - SUFFIX - 1);
    const seed = JSON.stringify(draft);
    for (let n = 0; ; n++) {
      const h = createHash("sha256").update(this.salt).update(seed).update(String(n)).digest();
      const id = `${base}-${(h.readUInt32BE(0) % 36 ** SUFFIX).toString(36).padStart(SUFFIX, "0")}`;
      if (!taken(id)) return id;
    }
  }

  /** Check the fields a draft or update gives, and return them normalized. Throws a 400 for any that is wrong. */
  private fields(u: Record<string, unknown>, id: string | null): Partial<Goal> {
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
    if (u.parent !== undefined) throw bad("parent is gone: list the goal in its milestone's requires, or give parents");
    if (u.signOff !== undefined) throw bad("a sign-off is not part of the goal file: give it with /sign-off");
    if (u.requires !== undefined) out.requires = this.requiresList(u.requires, id);
    return out;
  }

  /** A requires list from a body: each { goal, required? } naming a goal here, each once. */
  private requiresList(v: unknown, self: string | null): GoalRequirement[] {
    if (v === null) return [];
    if (!Array.isArray(v)) throw bad("requires must be a list of { goal, required? }");
    const out: GoalRequirement[] = [];
    for (const [i, r] of v.entries()) {
      const one = this.requirementOf(r, `required goal ${i + 1}`);
      if (one.goal === self) throw bad("a goal cannot require itself");
      if (!out.some((x) => x.goal === one.goal)) out.push(one);
    }
    return out;
  }

  /** One { goal, required? } from a body, naming a goal here. */
  private requirementOf(r: unknown, what = "body"): GoalRequirement {
    const o = typeof r === "string" ? { goal: r } : r;
    if (!isObject(o) || typeof o.goal !== "string" || !o.goal) throw bad(`${what} must be { goal, required? }`);
    if (o.required !== undefined && typeof o.required !== "boolean") throw bad(`${what}: required must be a boolean`);
    if (!this.goals.has(o.goal)) throw bad(`no goal ${o.goal}`);
    return { goal: o.goal, ...(o.required === false ? { required: false } : {}) };
  }

  /** The parents a body gives: goal ids here, each once, never the goal itself. */
  private parentsOf(v: unknown, self: string | null): string[] {
    if (!Array.isArray(v) || v.some((p) => typeof p !== "string")) throw bad("parents must be a list of goal ids");
    const out = [...new Set(v as string[])];
    for (const p of out) {
      if (p === self) throw bad("a goal cannot require itself");
      if (!this.goals.has(p)) throw bad(`no goal ${p}`);
    }
    return out;
  }

  /** Refuse goals as they would be when one requires another in a loop: 400 naming the loop. */
  private refuseLoops(next: Goal[]): void {
    const graph = new Map(this.list().map((g) => [g.id, g]));
    for (const g of next) graph.set(g.id, g);
    const all = [...graph.values()];
    for (const g of next) {
      const had = new Set(requiresOf(this.goals.get(g.id)?.goal ?? { requires: [] }).map((r) => r.goal));
      for (const r of requiresOf(g)) {
        if (had.has(r.goal)) continue;
        const loop = loopIfRequired(all, g.id, r.goal);
        if (loop) throw bad(`that would make goals require each other in a loop: ${loopText(loop)}`);
      }
    }
  }

  /**
   * The parents as they would be with `id` required by exactly `parents`: a
   * new parent gains the entry at its end, a parent not named loses it. Only
   * the goals that change.
   */
  private parentFiles(id: string, parents: string[]): Goal[] {
    const out: Goal[] = [];
    for (const g of this.list()) {
      const reqs = requiresOf(g);
      const has = reqs.some((r) => r.goal === id);
      const wants = parents.includes(g.id);
      if (has === wants) continue;
      out.push(clean({ ...g, requires: wants ? [...reqs, { goal: id }] : reqs.filter((r) => r.goal !== id) }));
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

  /** Create a goal; `parents` in the draft each gain it at the end of their requires. The first goal brings the schema and README. */
  async create(draft: unknown): Promise<Goal> {
    const goal = this.planCreate(draft);
    const parents = isObject(draft) && draft.parents !== undefined ? this.parentsOf(draft.parents, null) : [];
    const files = this.parentFiles(goal.id, parents);
    this.refuseLoops([goal, ...files]);
    fs.mkdirSync(this.dir, { recursive: true });
    await this.writeMissingDocs();
    await this.write([goal, ...files]);
    return this.must(goal.id);
  }

  /** The goal create() would write, without writing it. */
  planCreate(draft: unknown): Goal {
    if (!isObject(draft)) throw bad("body must be a goal: { title, ... }");
    const d = draft as Partial<GoalDraft> & Record<string, unknown>;
    if (!str(d.title, MAX_TITLE)) throw bad("title must be a non-empty string");
    if (d.kind !== undefined && d.kind !== "goal" && d.kind !== "milestone") throw bad("kind must be goal or milestone");
    const f = this.fields(d, null);
    const id = this.freshId(d.id, f.title!, draft);
    if (f.requires?.some((r) => r.goal === id)) throw bad("a goal cannot require itself");
    return {
      schema: HUB_SCHEMA,
      id,
      kind: d.kind ?? "goal",
      title: f.title!,
      ...(f.description ? { description: f.description } : {}),
      ...(f.owner ? { owner: f.owner } : {}),
      ...(f.priority ? { priority: f.priority } : {}),
      ...(f.tags?.length ? { tags: f.tags } : {}),
      ...(f.due ? { due: f.due } : {}),
      ...(f.links?.length ? { links: f.links } : {}),
      acceptance: f.acceptance ?? { ...DEFAULT_ACCEPTANCE },
      ...(f.requires?.length ? { requires: f.requires } : {}),
      checks: f.checks ?? [],
      ...(f.archived ? { archived: true } : {}),
    };
  }

  /** Change a goal; `parents`, when given, makes exactly those goals require it, writing their files. */
  async update(id: string, u: unknown): Promise<Goal> {
    const next = this.planUpdate(id, u);
    const parents = isObject(u) && u.parents !== undefined ? this.parentsOf(u.parents, id) : null;
    const files = parents ? this.parentFiles(id, parents) : [];
    this.refuseLoops([next, ...files]);
    await this.write([next, ...files]);
    return this.must(id);
  }

  /** The goal update() would write, without writing it. Parents' files are not part of it. */
  planUpdate(id: string, u: unknown): Goal {
    const had = this.must(id);
    if (!isObject(u)) throw bad("body must be the fields to change");
    const upd = u as GoalUpdate & Record<string, unknown>;
    if (upd.kind !== undefined && upd.kind !== "goal" && upd.kind !== "milestone") throw bad("kind must be goal or milestone");
    const f = this.fields(upd, id);
    const next = clean({ ...had, ...f, kind: upd.kind ?? had.kind, schema: HUB_SCHEMA, id });
    this.refuseLoops([next]);
    return next;
  }

  async addRequire(id: string, body: unknown): Promise<Goal> {
    const next = this.planRequire(id, body);
    if (next !== this.get(id)) await this.write([next]);
    return this.must(id);
  }

  /**
   * A goal requiring one more goal, at the end of its list, without writing
   * it. A goal it requires already keeps its place and takes the required
   * given; with nothing to change, the goal as it is.
   */
  planRequire(id: string, body: unknown): Goal {
    const had = this.must(id);
    const r = this.requirementOf(body);
    if (r.goal === id) throw bad("a goal cannot require itself");
    const reqs = requiresOf(had);
    const at = reqs.findIndex((x) => x.goal === r.goal);
    const asked = isObject(body) ? body.required : undefined;
    if (at >= 0) {
      if (asked === undefined || (reqs[at].required !== false) === asked) return had;
      return { ...had, requires: reqs.map((x, i) => (i === at ? r : x)) };
    }
    const next = { ...had, requires: [...reqs, r] };
    this.refuseLoops([next]);
    return next;
  }

  async removeRequire(id: string, goal: string): Promise<Goal> {
    await this.write([this.planUnrequire(id, goal)]);
    return this.must(id);
  }

  /** A goal no longer requiring one goal, without writing it. */
  planUnrequire(id: string, goal: string): Goal {
    const had = this.must(id);
    const reqs = requiresOf(had);
    if (!reqs.some((r) => r.goal === goal)) throw notFound(`goal ${id} does not require ${goal}`);
    return clean({ ...had, requires: reqs.filter((r) => r.goal !== goal) });
  }

  /** The goals a goal requires in a new order: body { order } names each of them once. */
  async orderRequires(id: string, body: unknown): Promise<Goal> {
    const had = this.must(id);
    const reqs = requiresOf(had);
    const order = orderOf(body, reqs.map((r) => r.goal), "required goal");
    await this.write([{ ...had, requires: order.map((g) => reqs.find((r) => r.goal === g)!) }]);
    return this.must(id);
  }

  /** A goal's checks in a new order: body { order } names each check id once. */
  async orderChecks(id: string, body: unknown): Promise<Goal> {
    const had = this.must(id);
    const order = orderOf(body, had.checks.map(checkId), "check");
    await this.write([{ ...had, checks: order.map((c) => had.checks.find((x) => checkId(x) === c)!) }]);
    return this.must(id);
  }

  async updateCheck(id: string, check: string, u: unknown): Promise<Goal> {
    await this.write([this.planUpdateCheck(id, check, u)]);
    return this.must(id);
  }

  /** One check of a goal with its title, required or links changed (CheckUpdate), without writing it. */
  planUpdateCheck(id: string, check: string, u: unknown): Goal {
    const had = this.must(id);
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
    return { ...had, checks };
  }

  /** The goals that require this one. */
  parentsOfGoal(id: string): Goal[] {
    return this.list().filter((g) => requiresOf(g).some((r) => r.goal === id));
  }

  /**
   * Delete a goal, through source control. Goals that required it stop
   * requiring it; the goals it required stay, on their own if nothing else
   * requires them.
   */
  async delete(id: string): Promise<void> {
    this.must(id);
    const files = this.parentFiles(id, []);
    // An old file naming this goal as its parent loses the name, since the goal is gone.
    const orphans = [...this.goals.values()].filter((e) => e.legacyParent === id && !files.some((f) => f.id === e.goal.id)).map((e) => e.goal);
    await this.writer.remove(this.fileOf(id));
    this.goals.delete(id);
    this.o.changed?.(id);
    if (files.length || orphans.length) await this.write([...files, ...orphans]);
    else this.read();
  }

  async addChecks(id: string, checks: unknown): Promise<Goal> {
    const had = this.must(id);
    const add = this.checksOf(checks);
    if (add.length === 0) throw bad("body must be { checks: [{ kind, target }] } with at least one check");
    const known = new Set(had.checks.map(checkId));
    const fresh = add.filter((c) => !known.has(checkId(c)));
    if (fresh.length === 0) return had;
    await this.write([{ ...had, checks: [...had.checks, ...fresh] }]);
    return this.must(id);
  }

  async removeCheck(id: string, check: string): Promise<Goal> {
    const had = this.must(id);
    const checks = had.checks.filter((c) => checkId(c) !== check);
    if (checks.length === had.checks.length) throw notFound(`goal ${id} has no check ${check}`);
    await this.write([{ ...had, checks }]);
    return this.must(id);
  }
}

/** A new order from body { order }: every id in `have` once, nothing else. */
function orderOf(body: unknown, have: string[], what: string): string[] {
  const order = isObject(body) ? body.order : undefined;
  if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) throw bad(`body must be { order: [${what} ids] }`);
  const ids = order as string[];
  if (ids.length !== have.length || new Set(ids).size !== ids.length || ids.some((x) => !have.includes(x))) throw bad(`order must name each ${what} once: ${have.join(", ") || "there are none"}`);
  return ids;
}

/** A goal without empty optional fields, so the file stays as short as the goal is. */
function clean(g: Goal): Goal {
  const out = { ...g } as Record<string, unknown>;
  for (const k of ["description", "owner", "due"]) if (out[k] === null || out[k] === undefined || out[k] === "") delete out[k];
  if (Array.isArray(out.requires) && out.requires.length === 0) delete out.requires;
  if (Array.isArray(out.tags) && out.tags.length === 0) delete out.tags;
  if (Array.isArray(out.links) && out.links.length === 0) delete out.links;
  if (out.archived === false) delete out.archived;
  return out as unknown as Goal;
}
