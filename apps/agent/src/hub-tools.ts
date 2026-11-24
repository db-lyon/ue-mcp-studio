/**
 * The Playtest Hub's tools for Studio's own agent, so it can do the tracker
 * work a project's agent does: list goals with their status, read a goal or a
 * playtest, create and update goals, put goals under milestones, and link
 * goals, playtests and runs to tracker items. Only the main agent has them,
 * and only while the Playtest Hub experiment is on.
 *
 * Every change goes to the project's goal store (hub/goals.ts), never to a
 * project file, so none asks as a file change does; the hub's own routes for
 * them need no PIN either (remote/pin-lock.ts).
 */
import { GOAL_PRIORITIES, TRACKER_LINKS_MAX, TRACKER_LINK_RELS, type TrackerLink } from "@ue-mcp-studio/shared";
import type { Hub } from "./hub/hub.js";
import { HubError, bad, linkOf, notFound } from "./hub/util.js";

export const HUB_LIST_GOALS = "hub_list_goals";
export const HUB_READ_GOAL = "hub_read_goal";
export const HUB_READ_CHECK = "hub_read_check";
export const HUB_CREATE_GOAL = "hub_create_goal";
export const HUB_UPDATE_GOAL = "hub_update_goal";
export const HUB_ADD_LINK = "hub_add_link";
export const HUB_REMOVE_LINK = "hub_remove_link";
export const HUB_REQUIRE_GOAL = "hub_require_goal";
export const HUB_UNREQUIRE_GOAL = "hub_unrequire_goal";

export const HUB_TOOL_NAMES: readonly string[] = [HUB_LIST_GOALS, HUB_READ_GOAL, HUB_READ_CHECK, HUB_CREATE_GOAL, HUB_UPDATE_GOAL, HUB_ADD_LINK, HUB_REMOVE_LINK, HUB_REQUIRE_GOAL, HUB_UNREQUIRE_GOAL];
export const isHubTool = (name: string): boolean => HUB_TOOL_NAMES.includes(name);

/** What the tools need of the hub. */
export type HubToolTarget = Pick<Hub, "goals" | "overview" | "goal" | "check" | "addRunLink" | "removeRunLink" | "updateCheckMeta">;

const S = (description: string) => ({ type: "string", description });
const RELS = TRACKER_LINK_RELS.join(", ");
const GOAL_FIELDS = {
  title: S("What the game must do, in a sentence"),
  kind: { type: "string", enum: ["goal", "milestone"], description: "goal (default), or milestone: a goal shown as a heading, usually one that requires other goals" },
  description: S("What done means, in Markdown"),
  owner: { type: ["string", "null"], description: "Who owns the goal, as the team names people; null clears it" },
  priority: { type: ["string", "null"], enum: [...GOAL_PRIORITIES, null], description: "p0 (most urgent) to p3; null clears it" },
  due: { type: ["string", "null"], description: "YYYY-MM-DD, or null" },
  acceptance: {
    type: "object",
    description: "When the goal is met",
    properties: {
      stableRuns: { type: "integer", description: "How many passes in a row each required playtest needs, 1 to 10" },
      signOff: { type: "boolean", description: "A person signs the goal off before it is met" },
    },
  },
  checks: {
    type: "array",
    description: "The playtests that prove the goal, in order; given, it replaces the list. Each is { kind: \"script\", target: the script's asset path without the object name, required? }.",
    items: {
      type: "object",
      properties: { kind: { type: "string", enum: ["script"] }, target: { type: "string" }, required: { type: "boolean" } },
      required: ["kind", "target"],
    },
  },
  requires: {
    type: "array",
    description: "The goals this goal requires, in order, each { goal: id, required? }; given, it replaces the list. To put a goal under a milestone, add it to the milestone's requires (hub_require_goal). A goal can be required by any number of goals and milestones.",
    items: { type: "object", properties: { goal: { type: "string" }, required: { type: "boolean" } }, required: ["goal"] },
  },
  links: {
    type: "array",
    description: `Tracker items the goal refers to, each { url, title?, rel? }; given, it replaces the list. rel is free text, usually one of ${RELS}.`,
    items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" }, rel: { type: "string" } }, required: ["url"] },
  },
  archived: { type: "boolean", description: "Hide the goal from the overview" },
};
const TARGET = {
  goal_id: S("A goal to link"),
  check_id: S("A playtest to link, as script:<asset path> (from hub_read_goal). Its links are its own, wherever it is listed"),
  run_id: S("A run to link (from hub_read_check)"),
};

export const HUB_TOOLS = [
  {
    name: HUB_LIST_GOALS,
    description: "List the Playtest Hub's goals and milestones with their status (failing, ready_to_sign_off, at_risk, running, in_progress, not_started, met), progress, owner, priority, due date, the goals each requires and is part of, and links. Goals are kept in the project's goal store, outside the repo. Status comes from the playtests' runs on this computer, rolled up through required goals, and is never stored. unused: no milestone or goal requires it.",
    input_schema: { type: "object" as const, properties: { include_archived: { type: "boolean", description: "Also list archived goals" } } },
  },
  {
    name: HUB_READ_GOAL,
    description: "Read one goal: its fields, its status, and each playtest with its health, latest run and links. A playtest missing on this checkout shows health missing; that is no failure of the goal.",
    input_schema: { type: "object" as const, properties: { id: S("The goal's id") }, required: ["id"] },
  },
  {
    name: HUB_READ_CHECK,
    description: "Read one playtest: its health, the goals that list it, its links, and its latest runs with their ids and links.",
    input_schema: { type: "object" as const, properties: { check_id: S("The playtest, as script:<asset path>"), limit: { type: "integer", description: "How many runs, 10 by default, at most 50" } }, required: ["check_id"] },
  },
  {
    name: HUB_CREATE_GOAL,
    description: "Create a goal in the project's goal store. Its id is made from the title and a short random ending unless id is given. Only title is required.",
    input_schema: { type: "object" as const, properties: { id: S("An id to use: lowercase letters, digits and dashes"), ...GOAL_FIELDS }, required: ["title"] },
  },
  {
    name: HUB_UPDATE_GOAL,
    description: "Change a goal's fields. Only the fields given change; checks, requires and links, when given, replace the lists. To add or remove one link, use hub_add_link or hub_remove_link.",
    input_schema: { type: "object" as const, properties: { id: S("The goal's id"), ...GOAL_FIELDS }, required: ["id"] },
  },
  {
    name: HUB_ADD_LINK,
    description: `Link a goal, a playtest or a run to an item in a tracker or anywhere else: an issue, a ticket, a card, a document. Give exactly one of goal_id, check_id and run_id. Any URL with a scheme works except javascript:, data: and file:; Studio stores it and never contacts it. A link to a URL already there is replaced. rel says how the item relates, free text, usually one of ${RELS}.`,
    input_schema: {
      type: "object" as const,
      properties: { url: S("The item's URL"), title: S("What the link is shown as, such as the issue's title"), rel: S(`How it relates: ${RELS}, or other text`), ...TARGET },
      required: ["url"],
    },
  },
  {
    name: HUB_REMOVE_LINK,
    description: "Remove a link, by its URL, from a goal, a playtest or a run. Give exactly one of goal_id, check_id and run_id.",
    input_schema: { type: "object" as const, properties: { url: S("The link's URL"), ...TARGET }, required: ["url"] },
  },
  {
    name: HUB_REQUIRE_GOAL,
    description: "Make one goal require another: goal_id (often a milestone) is met only when requires is. Added at the end of goal_id's list; a goal it requires already keeps its place and takes the required given. A goal can be required by any number of goals, so the same goal can sit under several milestones. A loop is refused.",
    input_schema: {
      type: "object" as const,
      properties: { goal_id: S("The goal or milestone that requires"), requires: S("The goal it requires"), required: { type: "boolean", description: "False: goal_id is met without it. True by default" } },
      required: ["goal_id", "requires"],
    },
  },
  {
    name: HUB_UNREQUIRE_GOAL,
    description: "Stop one goal requiring another. Only goal_id changes; the other goal stays.",
    input_schema: { type: "object" as const, properties: { goal_id: S("The goal or milestone that requires"), requires: S("The goal it should no longer require") }, required: ["goal_id", "requires"] },
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
    case HUB_REQUIRE_GOAL:
    case HUB_UNREQUIRE_GOAL:
      if (!str(i.goal_id) || !str(i.requires)) return `${name} needs goal_id and requires`;
      return i.required === undefined || (name === HUB_REQUIRE_GOAL && typeof i.required === "boolean") ? null : "required must be a boolean, given only to hub_require_goal";
    case HUB_ADD_LINK:
    case HUB_REMOVE_LINK: {
      if (!str(i.url)) return `${name} needs url`;
      const given = ["goal_id", "check_id", "run_id"].filter((k) => i[k] !== undefined);
      for (const k of given) if (!str(i[k])) return `${k} must be text`;
      return given.length === 1 ? null : "say what to link: exactly one of goal_id, check_id and run_id";
    }
  }
  return `unknown tool ${name}`;
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

type Result = { text: string; isError: boolean };
const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** Run one hub tool. `hub` is null while the experiment is off. */
export async function runHubTool(hub: HubToolTarget | null, name: string, input: Record<string, unknown>): Promise<Result> {
  if (!hub) return { text: "The Playtest Hub is off. The user turns it on in Settings, under Experiments.", isError: true };
  const invalid = validateHub(name, input);
  if (invalid) return { text: invalid, isError: true };
  const g = hub.goals;
  try {
    switch (name) {
      case HUB_LIST_GOALS: {
        const o = await hub.overview();
        const goals = o.goals.filter((s) => input.include_archived === true || !s.goal.archived).map((s) => ({
          id: s.goal.id,
          kind: s.goal.kind,
          title: s.goal.title,
          status: s.status,
          progress: `${s.progress.met}/${s.progress.total}`,
          ...(s.parents.length ? { partOf: s.parents } : {}),
          ...(s.requires.length ? { requires: s.requires.map((r) => r.goal) } : {}),
          ...(s.unused ? { unused: true } : {}),
          ...(s.goal.owner ? { owner: s.goal.owner } : {}),
          ...(s.goal.priority ? { priority: s.goal.priority } : {}),
          ...(s.goal.due ? { due: s.goal.due } : {}),
          checks: s.checks.length,
          ...(s.goal.links?.length ? { links: s.goal.links } : {}),
          ...(s.goal.archived ? { archived: true } : {}),
        }));
        return { text: json({ goals, ...(o.warnings.length ? { warnings: o.warnings } : {}) }), isError: false };
      }
      case HUB_READ_GOAL: {
        const s = await hub.goal(String(input.id));
        return {
          text: json({
            status: s.status,
            progress: s.progress,
            goal: s.goal,
            checks: s.checks.map((c) => ({
              id: c.id,
              name: c.name,
              health: c.health,
              ...(c.check.required === false ? { required: false } : {}),
              ...(c.renamedFrom ? { movedFrom: c.renamedFrom } : {}),
              ...(c.last ? { last: { runId: c.last.runId, outcome: c.last.outcome, startedAt: c.last.startedAt } } : {}),
              ...(c.links?.length ? { links: c.links } : {}),
            })),
            ...(s.requires.length ? { requires: s.requires } : {}),
            ...(s.parents.length ? { partOf: s.parents } : {}),
            ...(s.unused ? { unused: "no milestone or goal requires it" } : {}),
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
            ...(d.state.links?.length ? { links: d.state.links } : {}),
            runs: d.runs.map((r) => ({ runId: r.runId, outcome: r.outcome, startedAt: r.startedAt, ...(r.failedSteps?.length ? { failedSteps: r.failedSteps.map((s) => s + 1) } : {}), ...(r.links?.length ? { links: r.links } : {}) })),
            more: d.more,
          }),
          isError: false,
        };
      }
      case HUB_ADD_LINK:
      case HUB_REMOVE_LINK: {
        if (str(input.run_id)) {
          const r = name === HUB_ADD_LINK ? hub.addRunLink(input.run_id, { link: { url: input.url, title: input.title, rel: input.rel } }) : hub.removeRunLink(input.run_id, input.url);
          return { text: json({ runId: r.runId, links: r.links ?? [] }), isError: false };
        }
        if (str(input.check_id)) {
          const id = input.check_id;
          const had = (await hub.check(id, { limit: 1 })).state.links;
          const meta = hub.updateCheckMeta(id, { links: changedLinks(had, name, input) });
          return { text: json({ checkId: id, links: meta.links ?? [] }), isError: false };
        }
        const goalId = String(input.goal_id);
        const goal = g.get(goalId);
        if (!goal) throw notFound(`no goal ${goalId}`);
        const saved = g.update(goalId, { links: changedLinks(goal.links, name, input) });
        return { text: json({ goalId, links: saved.links ?? [] }), isError: false };
      }
      case HUB_CREATE_GOAL:
        return { text: `Created:\n${json(g.create(input))}`, isError: false };
      case HUB_UPDATE_GOAL: {
        const { id, ...u } = input;
        return { text: `Saved:\n${json(g.update(String(id), u))}`, isError: false };
      }
      case HUB_REQUIRE_GOAL: {
        const body = { goal: input.requires, ...(input.required !== undefined ? { required: input.required } : {}) };
        return { text: `Saved:\n${json(g.addRequire(String(input.goal_id), body))}`, isError: false };
      }
      case HUB_UNREQUIRE_GOAL:
        return { text: `Saved:\n${json(g.removeRequire(String(input.goal_id), String(input.requires)))}`, isError: false };
    }
    return { text: `Unknown tool ${name}.`, isError: true };
  } catch (e) {
    if (e instanceof HubError) return { text: e.message, isError: true };
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
