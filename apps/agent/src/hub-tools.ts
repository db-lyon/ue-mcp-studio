/**
 * The Playtest Hub's tools for Studio's own agent, so it can do the tracker
 * work a project's external agent does with the goal files: list goals with
 * their status, read a goal or a check, create and update goals, and link
 * goals, checks and runs to tracker items. Only the main agent has them, and
 * only while the Playtest Hub experiment is on.
 *
 * A change to a goal writes its file in the project (QA/Goals/<id>.json), so
 * it asks as a file change does (the "files" approval row), showing the goal
 * file's diff. A run's links are per-machine history, not a project file, and
 * do not ask; the hub's own routes for them need no PIN either (remote/pin-lock.ts).
 */
import { TRACKER_LINKS_MAX, TRACKER_LINK_RELS, lineDiff, type Goal, type TrackerLink } from "@ue-mcp-studio/shared";
import type { Hub } from "./hub/hub.js";
import { HubError, bad, linkOf, notFound } from "./hub/util.js";
import type { ApprovalPreview } from "./local-tools.js";

export const HUB_LIST_GOALS = "hub_list_goals";
export const HUB_READ_GOAL = "hub_read_goal";
export const HUB_READ_CHECK = "hub_read_check";
export const HUB_CREATE_GOAL = "hub_create_goal";
export const HUB_UPDATE_GOAL = "hub_update_goal";
export const HUB_ADD_LINK = "hub_add_link";
export const HUB_REMOVE_LINK = "hub_remove_link";

export const HUB_TOOL_NAMES: readonly string[] = [HUB_LIST_GOALS, HUB_READ_GOAL, HUB_READ_CHECK, HUB_CREATE_GOAL, HUB_UPDATE_GOAL, HUB_ADD_LINK, HUB_REMOVE_LINK];
export const isHubTool = (name: string): boolean => HUB_TOOL_NAMES.includes(name);

/** What the tools need of the hub. */
export type HubToolTarget = Pick<Hub, "goals" | "overview" | "goal" | "check" | "addRunLink" | "removeRunLink">;

const S = (description: string) => ({ type: "string", description });
const RELS = TRACKER_LINK_RELS.join(", ");
const GOAL_FIELDS = {
  title: S("What the game must do, in a sentence"),
  kind: { type: "string", enum: ["goal", "milestone"], description: "goal (default), or milestone for a group of goals" },
  description: S("What done means, in Markdown"),
  parent: { type: ["string", "null"], description: "The id of the milestone this goal belongs to; null for none" },
  owner: { type: ["string", "null"], description: "Who owns the goal" },
  priority: { type: "string", enum: ["p0", "p1", "p2", "p3"] },
  tags: { type: "array", items: { type: "string" } },
  due: { type: ["string", "null"], description: "YYYY-MM-DD, or null" },
  acceptance: {
    type: "object",
    description: "When the goal is met",
    properties: {
      stableRuns: { type: "integer", description: "How many latest runs of each required check must all pass, 1 to 10" },
      staleAfterDays: { type: ["number", "null"], description: "A passing check not run for this many days puts the goal at risk; null for never" },
      signOff: { type: "boolean", description: "A person signs the goal off before it is met" },
    },
  },
  checks: {
    type: "array",
    description: "The checks that prove the goal; given, it replaces the list. A script's target is its asset path without the object name.",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["script", "uat", "repro", "automation", "manual"] },
        target: { type: "string" },
        title: { type: "string" },
        required: { type: "boolean" },
        links: { type: "array", items: { type: "object" } },
      },
      required: ["kind", "target"],
    },
  },
  links: {
    type: "array",
    description: `Tracker items the goal refers to, each { url, title?, rel? }; given, it replaces the list. rel is free text, usually one of ${RELS}.`,
    items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" }, rel: { type: "string" } }, required: ["url"] },
  },
  archived: { type: "boolean", description: "Hide the goal from the overview" },
};
const TARGET = {
  goal_id: S("The goal to link, or the goal whose check to link"),
  check_id: S("A check, as <kind>:<target> (from hub_read_goal). With goal_id, that goal's entry for it; without, the one goal that lists it"),
  run_id: S("A run (from hub_read_check). Give it alone"),
};

export const HUB_TOOLS = [
  {
    name: HUB_LIST_GOALS,
    description: "List the Playtest Hub's goals and milestones with their status (needs_you, failing, at_risk, running, not_started, met), progress, links and the folder their files are in. Status comes from the checks' runs and is never stored.",
    input_schema: { type: "object" as const, properties: { include_archived: { type: "boolean", description: "Also list archived goals" } } },
  },
  {
    name: HUB_READ_GOAL,
    description: "Read one goal: its fields as its file holds them, its status, and each check with its health, latest run and links.",
    input_schema: { type: "object" as const, properties: { id: S("The goal's id") }, required: ["id"] },
  },
  {
    name: HUB_READ_CHECK,
    description: "Read one check: its health, the goals that list it, the links any of them give it, and its latest runs with their ids and links.",
    input_schema: { type: "object" as const, properties: { check_id: S("The check, as <kind>:<target>"), limit: { type: "integer", description: "How many runs, 10 by default, at most 50" } }, required: ["check_id"] },
  },
  {
    name: HUB_CREATE_GOAL,
    description: `Create a goal: a file in the project's goals folder (QA/Goals by default), named by an id made from the title unless id is given. Only title is required. The user may be asked to allow it first.`,
    input_schema: { type: "object" as const, properties: { id: S("A file name to use: lowercase letters, digits and dashes"), ...GOAL_FIELDS }, required: ["title"] },
  },
  {
    name: HUB_UPDATE_GOAL,
    description: "Change a goal's fields. Only the fields given change; checks and links, when given, replace the lists. To add or remove one link, use hub_add_link or hub_remove_link. The user may be asked to allow it first.",
    input_schema: { type: "object" as const, properties: { id: S("The goal's id"), ...GOAL_FIELDS }, required: ["id"] },
  },
  {
    name: HUB_ADD_LINK,
    description: `Link a goal, one of its checks, or a run to an item in a tracker or anywhere else: an issue, a ticket, a card, a document. Any URL with a scheme works except javascript:, data: and file:; Studio stores it and never contacts it. A link to a URL already there is replaced. rel says how the item relates, free text, usually one of ${RELS}. Goal and check links are written to the goal's file, so the user may be asked to allow it first.`,
    input_schema: {
      type: "object" as const,
      properties: { url: S("The item's URL"), title: S("What the link is shown as, such as the issue's title"), rel: S(`How it relates: ${RELS}, or other text`), ...TARGET },
      required: ["url"],
    },
  },
  {
    name: HUB_REMOVE_LINK,
    description: "Remove a link, by its URL, from a goal, one of its checks, or a run. Goal and check links are written to the goal's file, so the user may be asked to allow it first.",
    input_schema: { type: "object" as const, properties: { url: S("The link's URL"), ...TARGET }, required: ["url"] },
  },
];

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Check a call's input; null when it is fine. */
export function validateHub(name: string, i: Record<string, unknown>): string | null {
  switch (name) {
    case HUB_LIST_GOALS:
      return i.include_archived === undefined || typeof i.include_archived === "boolean" ? null : "include_archived must be a boolean";
    case HUB_READ_GOAL:
    case HUB_UPDATE_GOAL:
      return str(i.id) ? null : `${name} needs id`;
    case HUB_READ_CHECK:
      if (!str(i.check_id)) return "hub_read_check needs check_id";
      return i.limit === undefined || Number.isInteger(i.limit) ? null : "limit must be a whole number";
    case HUB_CREATE_GOAL:
      return str(i.title) ? null : "hub_create_goal needs title";
    case HUB_ADD_LINK:
    case HUB_REMOVE_LINK: {
      if (!str(i.url)) return `${name} needs url`;
      for (const k of ["goal_id", "check_id", "run_id"]) if (i[k] !== undefined && !str(i[k])) return `${k} must be text`;
      if (i.run_id !== undefined && (i.goal_id !== undefined || i.check_id !== undefined)) return "give run_id alone, or goal_id and check_id";
      if (i.run_id === undefined && i.goal_id === undefined && i.check_id === undefined) return "say what to link: goal_id, check_id or run_id";
      return null;
    }
  }
  return `unknown tool ${name}`;
}

/** Whether a call changes a goal file, and so asks as a file change. */
export const hubChangesFiles = (name: string, i: Record<string, unknown>): boolean =>
  name === HUB_CREATE_GOAL || name === HUB_UPDATE_GOAL || ((name === HUB_ADD_LINK || name === HUB_REMOVE_LINK) && i.run_id === undefined);

interface GoalChange {
  create: boolean;
  /** The goal as it would be written. */
  plan: () => Goal;
  apply: () => Goal;
}

/** The goal a check link goes to: the one named, else the one goal listing the check. */
function checkGoal(hub: HubToolTarget, checkId: string, goalId: unknown): Goal {
  if (str(goalId)) {
    const g = hub.goals.get(goalId);
    if (!g) throw notFound(`no goal ${goalId}`);
    if (!g.checks.some((c) => `${c.kind}:${c.target}` === checkId)) throw notFound(`goal ${goalId} has no check ${checkId}`);
    return g;
  }
  const listing = hub.goals.list().filter((g) => g.checks.some((c) => `${c.kind}:${c.target}` === checkId));
  if (listing.length === 0) throw notFound(`no goal lists ${checkId}; add it to a goal first, then link it there`);
  if (listing.length > 1) throw bad(`${checkId} is in ${listing.length} goals (${listing.map((g) => g.id).join(", ")}): give goal_id`);
  return listing[0];
}

/** Links with one added (replacing a link to the same URL) or removed. */
function changedLinks(links: readonly TrackerLink[] | undefined, name: string, i: Record<string, unknown>): TrackerLink[] {
  const have = links ?? [];
  if (name === HUB_REMOVE_LINK) {
    if (!have.some((l) => l.url === i.url)) throw notFound(`there is no link to ${String(i.url)}`);
    return have.filter((l) => l.url !== i.url);
  }
  const link = linkOf({ url: i.url, title: i.title, rel: i.rel });
  const rest = have.filter((l) => l.url !== link.url);
  if (rest.length >= TRACKER_LINKS_MAX) throw bad(`at most ${TRACKER_LINKS_MAX} links`);
  return [...rest, link];
}

/** What a call does to a goal file, or null for a call that writes none. Throws a HubError for a call that cannot be made. */
function goalChange(hub: HubToolTarget, name: string, input: Record<string, unknown>): GoalChange | null {
  const g = hub.goals;
  if (name === HUB_CREATE_GOAL) return { create: true, plan: () => g.planCreate(input), apply: () => g.create(input) };
  if (name === HUB_UPDATE_GOAL) {
    const { id, ...u } = input;
    return { create: false, plan: () => g.planUpdate(String(id), u), apply: () => g.update(String(id), u) };
  }
  if ((name !== HUB_ADD_LINK && name !== HUB_REMOVE_LINK) || input.run_id !== undefined) return null;
  if (str(input.check_id)) {
    const checkId = input.check_id;
    const body = () => {
      const goal = checkGoal(hub, checkId, input.goal_id);
      return { id: goal.id, u: { links: changedLinks(goal.checks.find((c) => `${c.kind}:${c.target}` === checkId)?.links, name, input) } };
    };
    return {
      create: false,
      plan: () => { const b = body(); return g.planUpdateCheck(b.id, checkId, b.u); },
      apply: () => { const b = body(); return g.updateCheck(b.id, checkId, b.u); },
    };
  }
  const goalId = String(input.goal_id);
  const body = () => {
    const goal = g.get(goalId);
    if (!goal) throw notFound(`no goal ${goalId}`);
    return { links: changedLinks(goal.links, name, input) };
  };
  return { create: false, plan: () => g.planUpdate(goalId, body()), apply: () => g.update(goalId, body()) };
}

/** What the user is asked to allow for a call that writes a goal file: the file and its diff. Null when it writes none or will fail. */
export function hubPreview(hub: HubToolTarget, name: string, input: Record<string, unknown>): ApprovalPreview | null {
  try {
    const change = goalChange(hub, name, input);
    if (!change) return null;
    const goal = change.plan();
    const before = change.create ? "" : hub.goals.textOf(goal.id) ?? "";
    return { tool: change.create ? "write_file" : "edit_file", path: hub.goals.fileOf(goal.id), ...(change.create ? { creates: true } : {}), diff: lineDiff(before, hub.goals.textFor(goal)) };
  } catch {
    return null;
  }
}

type Result = { text: string; isError: boolean };
const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** Run one hub tool. `hub` is null while the experiment is off. */
export async function runHubTool(hub: HubToolTarget | null, name: string, input: Record<string, unknown>): Promise<Result> {
  if (!hub) return { text: "The Playtest Hub is off. The user turns it on in Settings, under Experiments.", isError: true };
  const invalid = validateHub(name, input);
  if (invalid) return { text: invalid, isError: true };
  try {
    const rel = (id: string) => `${hub.goals.relDir}/${id}.json`;
    switch (name) {
      case HUB_LIST_GOALS: {
        const o = await hub.overview();
        const goals = o.goals.filter((g) => input.include_archived === true || !g.goal.archived).map((g) => ({
          id: g.goal.id,
          kind: g.goal.kind,
          title: g.goal.title,
          status: g.status,
          progress: `${g.progress.met}/${g.progress.total}`,
          ...(g.goal.parent ? { parent: g.goal.parent } : {}),
          ...(g.goal.owner ? { owner: g.goal.owner } : {}),
          ...(g.goal.priority ? { priority: g.goal.priority } : {}),
          ...(g.goal.due ? { due: g.goal.due } : {}),
          checks: g.checks.length,
          ...(g.goal.links?.length ? { links: g.goal.links } : {}),
          ...(g.goal.archived ? { archived: true } : {}),
        }));
        return { text: json({ goalsDir: o.goalsDir, goals, ...(o.warnings.length ? { warnings: o.warnings } : {}) }), isError: false };
      }
      case HUB_READ_GOAL: {
        const s = await hub.goal(String(input.id));
        return {
          text: json({
            file: rel(s.goal.id),
            status: s.status,
            progress: s.progress,
            goal: s.goal,
            checks: s.checks.map((c) => ({
              id: c.id,
              name: c.name,
              health: c.health,
              ...(c.check.required === false ? { required: false } : {}),
              ...(c.last ? { last: { runId: c.last.runId, outcome: c.last.outcome, startedAt: c.last.startedAt } } : {}),
              ...(c.check.links?.length ? { links: c.check.links } : {}),
            })),
            ...(s.children.length ? { goals: s.children } : {}),
          }),
          isError: false,
        };
      }
      case HUB_READ_CHECK: {
        const limit = Math.min(50, Math.max(1, typeof input.limit === "number" ? input.limit : 10));
        const d = await hub.check(String(input.check_id), { limit });
        return {
          text: json({
            id: d.state.id,
            name: d.state.name,
            health: d.state.health,
            goals: d.state.goalIds,
            ...(d.state.check.links?.length ? { links: d.state.check.links } : {}),
            runs: d.runs.map((r) => ({ runId: r.runId, outcome: r.outcome, startedAt: r.startedAt, ...(r.failedSteps?.length ? { failedSteps: r.failedSteps.map((s) => s + 1) } : {}), ...(r.links?.length ? { links: r.links } : {}) })),
            more: d.more,
          }),
          isError: false,
        };
      }
      case HUB_ADD_LINK:
      case HUB_REMOVE_LINK:
        if (str(input.run_id)) {
          const r = name === HUB_ADD_LINK ? hub.addRunLink(input.run_id, { link: { url: input.url, title: input.title, rel: input.rel } }) : hub.removeRunLink(input.run_id, input.url);
          return { text: json({ runId: r.runId, links: r.links ?? [] }), isError: false };
        }
      // Falls through: a goal's or a check's link is a goal file change.
      case HUB_CREATE_GOAL:
      case HUB_UPDATE_GOAL: {
        const change = goalChange(hub, name, input)!;
        const goal = change.apply();
        return { text: `${change.create ? "Created" : "Saved"} ${rel(goal.id)}:\n${hub.goals.textOf(goal.id) ?? json(goal)}`, isError: false };
      }
    }
    return { text: `Unknown tool ${name}.`, isError: true };
  } catch (e) {
    if (e instanceof HubError) return { text: e.message, isError: true };
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
