/**
 * The two files Studio keeps beside the goal files, so any agent or person
 * can read and write goals correctly without Studio: goal.schema.json (JSON
 * Schema 2020-12 for one goal file, named by each file's "$schema") and
 * README.md (what a goal is, its fields, checks and links, and an example).
 *
 * The schema is built here from the same constants the reader checks
 * against (goals.ts parseGoal, util.ts checkRefOf, shared trackerLinkOf);
 * hub-goal-docs.test.ts checks that it accepts every goal the store writes
 * and that its properties are the fields the store writes.
 */
import {
  GOAL_ID,
  HUB_GOAL_SCHEMA_FILE,
  TRACKER_BLOCKED_SCHEMES,
  TRACKER_LINKS_MAX,
  TRACKER_LINK_RELS,
  TRACKER_REL_MAX,
  TRACKER_TITLE_MAX,
  TRACKER_URL_MAX,
  type Goal,
} from "@ue-mcp-studio/shared";

/** What each goal file names in "$schema": the schema beside it. */
export const GOAL_SCHEMA_REF = `./${HUB_GOAL_SCHEMA_FILE}`;

const KINDS = ["script", "uat", "repro", "automation", "manual"];
const PRIORITIES = ["p0", "p1", "p2", "p3"];

/** A regular expression source matching `word` in any case, for JSON Schema patterns, which take no flags. */
const anyCase = (word: string): string => [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join("");

/** A URL with a scheme, never one of the blocked schemes, with no spaces: the shape trackerUrlProblem allows. */
const URL_PATTERN = `^(?!(?:${TRACKER_BLOCKED_SCHEMES.map(anyCase).join("|")}):)[A-Za-z][A-Za-z0-9+.-]*:\\S+$`;

const link = {
  type: "object",
  description: "An item in a tracker or anywhere else that this refers to. Studio keeps the URL and never contacts it.",
  properties: {
    url: { type: "string", minLength: 1, maxLength: TRACKER_URL_MAX, pattern: URL_PATTERN, description: `http, https, mailto, or an app's own scheme such as jira://. Refused: ${TRACKER_BLOCKED_SCHEMES.map((s) => `${s}:`).join(", ")}.` },
    title: { type: "string", maxLength: TRACKER_TITLE_MAX, description: "What the link is shown as. Without one, the host." },
    rel: { type: "string", maxLength: TRACKER_REL_MAX, description: "How the item relates, free text.", examples: [...TRACKER_LINK_RELS] },
  },
  required: ["url"],
  additionalProperties: false,
};

const links = { type: "array", items: { $ref: "#/$defs/link" }, maxItems: TRACKER_LINKS_MAX };

const check = {
  type: "object",
  description: "A test that proves the goal. Its identity is kind and target.",
  properties: {
    kind: { enum: KINDS, description: "script: a ue-mcp PIE test script. uat and repro: a scenario or reproduction test file. automation: an Unreal automation test filter. manual: a checklist item a person signs off." },
    target: { type: "string", minLength: 1, description: "script: the asset path without the object name, such as /Game/Tests/PT_Jump. uat and repro: the file. automation: the filter. manual: the item's text." },
    title: { type: "string", description: "A display name; the script's own name otherwise." },
    required: { type: "boolean", description: "False: the goal is met without this check passing. True when absent." },
    links,
  },
  required: ["kind", "target"],
  additionalProperties: false,
  if: { properties: { kind: { const: "script" } } },
  then: { properties: { target: { type: "string", pattern: "^/" } } },
};

/** goal.schema.json. */
export const GOAL_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: HUB_GOAL_SCHEMA_FILE,
  title: "Playtest Hub goal",
  description: "One goal file in UE-MCP Studio's Playtest Hub. The file name is the goal's id. Only title is required. Fields this schema does not name are kept as written.",
  type: "object",
  properties: {
    $schema: { type: "string", description: `Where editors find this schema: ${GOAL_SCHEMA_REF}.` },
    schema: { const: 1, description: "The file format's version." },
    id: { type: "string", pattern: GOAL_ID.source, description: "The file name without .json." },
    kind: { enum: ["goal", "milestone"], description: "goal, or milestone: a label for a goal that groups others through requires. goal when absent." },
    title: { type: "string", minLength: 1, maxLength: 200, description: "What the game must do, in a sentence." },
    description: { type: "string", description: "What done means, in Markdown." },
    owner: { type: ["string", "null"] },
    priority: { enum: PRIORITIES },
    tags: { type: "array", items: { type: "string" } },
    due: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." },
    links: { ...links, description: "Issues, tickets and documents this goal refers to." },
    acceptance: {
      type: "object",
      description: "When the goal counts as met.",
      properties: {
        stableRuns: { type: "integer", minimum: 1, maximum: 10, description: "How many latest runs of each required check must all pass." },
        staleAfterDays: { type: ["number", "null"], exclusiveMinimum: 0, description: "A passing check not run for this many days puts the goal at risk. null: never." },
        signOff: { type: "boolean", description: "A person signs the goal off before it is met." },
      },
      additionalProperties: false,
    },
    requires: {
      type: "array",
      description: "Other goals this goal is met only with, in order. A goal can be required by any number of goals and milestones.",
      items: {
        type: "object",
        properties: {
          goal: { type: "string", pattern: GOAL_ID.source, description: "The required goal's id: its file name without .json." },
          required: { type: "boolean", description: "False: this goal is met without that one. True when absent." },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
    checks: { type: "array", items: { $ref: "#/$defs/check" } },
    archived: { type: "boolean", description: "Hidden from the overview." },
  },
  required: ["title"],
  $defs: { check, link },
} as const;

export const GOAL_SCHEMA_TEXT = `${JSON.stringify(GOAL_SCHEMA, null, 2)}\n`;

/** The README's example: a goal with checks and links, as the store would write it. */
export const EXAMPLE_GOAL: Goal = {
  schema: 1,
  id: "tutorial-glade-k3f9",
  kind: "goal",
  title: "A new player finishes the tutorial glade",
  description: "Walk, jump, light the lantern and leave the glade without help.",
  owner: "Ama",
  priority: "p0",
  tags: ["onboarding"],
  due: "2026-12-05",
  links: [{ url: "https://git.example.com/ember/hollow/issues/42", title: "Tutorial glade", rel: "counterpart" }],
  acceptance: { stableRuns: 2, staleAfterDays: 14, signOff: false },
  requires: [{ goal: "lantern-controls" }, { goal: "tutorial-subtitles", required: false }],
  checks: [
    { kind: "script", target: "/Game/Tests/Tutorial/PT_Tutorial_Jump" },
    { kind: "script", target: "/Game/Tests/Tutorial/PT_Tutorial_Exit", links: [{ url: "https://example.atlassian.net/browse/HOL-118", rel: "related" }] },
    { kind: "manual", target: "The lantern prompt is readable on a TV from the couch", required: false },
  ],
};

/** "a, b and c". */
const listed = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** README.md, with the example in the store's own format. */
export function goalsReadme(exampleText: string): string {
  return `# Goals

Each JSON file in this folder is one goal in UE-MCP Studio's Playtest Hub. The file name is the goal's id, in lowercase letters, digits and dashes, such as \`tutorial-glade-k3f9.json\`. Studio makes a new goal's id from its title and a short random ending, so goals created on two branches never share a file; a file written by hand keeps whatever id its name gives it. A goal's status is never stored here: Studio works it out from the runs of the goal's checks, and sign-offs, like runs, stay on the computer they were given on.

People and agents may edit these files directly. Studio picks up a change as soon as the file is saved, and a file it cannot read, such as one with merge conflict markers, shows as a warning in the hub without stopping the others from loading. Each goal file Studio creates names \`${HUB_GOAL_SCHEMA_FILE}\` in its \`"$schema"\` line, so editors that support JSON Schema check it as it is typed.

When Studio saves a goal it changes only the fields that changed and keeps everything else as written, including fields it does not know. Under Perforce it opens the file for edit first, marks a new goal for add and a deleted one for delete. It wrote this README and the schema with the first goal and does not change them again, so add your team's own conventions here.

## Fields

Only \`title\` is required. A goal Studio creates also has \`schema\`, \`id\`, \`kind\`, \`acceptance\` and \`checks\`.

| Field | Meaning |
|---|---|
| \`id\` | The file name without \`.json\`. |
| \`kind\` | \`goal\`, or \`milestone\`. A milestone is a goal shown as a heading in the hub, usually one that requires other goals. |
| \`title\` | What the game must do, in a sentence. |
| \`description\` | What done means, in Markdown. |
| \`owner\`, \`priority\`, \`tags\`, \`due\` | For planning: \`priority\` is \`p0\` to \`p3\`, \`due\` is \`YYYY-MM-DD\`. |
| \`links\` | Issues, tickets and documents the goal refers to. |
| \`acceptance\` | When the goal is met: the latest \`stableRuns\` runs (1 to 10) of every required check pass, and a person signs it off if \`acceptance.signOff\` is true. A passing check not run for \`staleAfterDays\` days puts the goal at risk; \`null\` turns that off. |
| \`requires\` | Other goals this goal needs, in order. See below. |
| \`checks\` | The tests that prove the goal. |
| \`archived\` | \`true\` hides the goal from the overview. |
| \`schema\` | The file format's version. |

## Checks

A check is a \`kind\` and a \`target\`:

| Kind | Target |
|---|---|
| \`script\` | A ue-mcp PIE test script, by asset path without the object name, such as \`/Game/Tests/PT_Jump\`. |
| \`uat\`, \`repro\` | The scenario or reproduction test file. |
| \`automation\` | An Unreal automation test filter. |
| \`manual\` | A checklist item a person signs off. The target is its text. |

Only \`script\` checks run today; checks of the other kinds can be listed but do not run yet. A check counts toward the goal unless it has \`"required": false\`. A check's \`title\` replaces its default name in the hub, and a check can have \`links\` of its own.

The same check can be listed in any number of goals, at a different place in each. It has one run history and one health wherever it is listed, so list it again rather than copying the script.

## Required goals

\`requires\` lists other goals by id, each as \`{ "goal": "<id>" }\`, in the order they are run. A goal is met only when every goal it requires is met; one with \`"required": false\` is listed and run but does not hold the goal back. Running a goal runs the checks of every goal it requires, at any depth, and then its own, each check once.

The requirement is written only in the file of the goal that requires. A goal can be required by any number of goals and milestones, so the same goal can sit under two milestones without a copy: list it in the \`requires\` of each. A milestone is grouped this way too:

\`\`\`json
{ "title": "Vertical Slice", "kind": "milestone", "requires": [{ "goal": "tutorial-glade" }, { "goal": "lantern-combat" }] }
\`\`\`

Goals cannot require each other in a loop: Studio refuses the change, and reports a loop written by hand as a warning. A goal that is not a milestone and that nothing requires shows in the hub as not part of any milestone, and a check no goal lists as not part of any goal, so neither goes stale unnoticed.

Files written by an older Studio may name a milestone in \`"parent"\`. Studio reads that as the milestone requiring the goal. The goal joins the milestone's \`requires\` the next time Studio saves the milestone's file, and \`"parent"\` goes the next time it saves the goal's own file after that.

## Links

A link is a \`url\` with an optional \`title\` and \`rel\`. Studio stores the URL and never contacts it, so any tracker works. \`rel\` is free text saying how the item relates; the usual values are ${listed(TRACKER_LINK_RELS.map((r) => `\`${r}\``))}. A URL can be http, https, mailto or an app's own scheme such as \`jira://\`. ${listed(TRACKER_BLOCKED_SCHEMES.map((s) => `\`${s}:\``))} URLs are refused.

Runs are kept on each computer rather than here, so link a run from its screen in the hub.

## Example

\`\`\`json
${exampleText.trimEnd()}
\`\`\`
`;
}
