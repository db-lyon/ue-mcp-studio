# Goals, trackers and the team path: a fresh-eyes recommendation

2026-11-23. Written without reference to what the branch has built. The earlier proposals in `review.md` were read as data about what the owner rejected, not as candidate answers.

## The problem, restated

Three kinds of information exist, and each already has an owner:

- **Work and planning:** what to build, who builds it, by when, in which milestone. The tracker owns this, whatever the tracker is.
- **What the game must do, stated so a machine can check it:** the playtest. It lives in the game repo, versioned with the code it tests.
- **Whether it does:** run evidence. It exists only on the machine that ran it.

The owner's dissatisfaction with every earlier proposal has one cause. Each one introduced a fourth thing, the goal, which restated the tracker's structure (issues, milestones, the hierarchy between them) inside Studio. Once two systems hold the same hierarchy, someone has to keep them aligned: an agent, a connector or a person. That is the duplication the owner is trying to avoid, whether the copy sits in the repo, in a local store or in a cache filled by a connector.

## How comparable tools split this

- **TestRail and Zephyr** keep their own milestones, plans and suites beside the issue tracker. Teams regularly complain about exactly this duplication. The part of TestRail that ages well is its plain **References** field on a test case: free text such as `PROJ-123`, with coverage reports grouped by that text. It needs no integration to be useful.
- **Xray** makes requirements and tests Jira issues, which removes the duplication by tying everything to one tracker. That choice is what Studio must not make.
- **CI checks** on GitHub or Gitea attach evidence to commits, never to issues. Issues connect to evidence through references in text (`Fixes #42`), and the tracker renders the link. The tracker stays the one place work lives, and CI never models it.
- **Test tags** (pytest markers, Unreal automation filters, Playwright tags) are how most teams group tests. Groups are derived from tags at query time, so there is no group object to keep in sync.

A solo developer needs to know which playtests prove a given issue, whether they pass now, and how to run them. A 50-person studio needs the same answers, visible to everyone, plus readiness for a release and a record of who accepted what on which build. Neither needs a second planning hierarchy. The studio needs **shared evidence**, which no file format solves before a shared service exists.

## 1. Should the hub have goals?

No stored goal object. Its two useful jobs are done by something simpler.

**Grouping** comes from **tags on the playtest itself**. A tag is a free-form string: a feature area (`tutorial`), a tracker reference written as a URL (`https://git.example.com/game/issues/42`), or any label a team uses. The hub derives a group for every tag in use and gives it a status rolled up from its playtests. "Which playtests prove issue 42, and do they pass?" is a tag query.

**Permanence** is the one real argument for goals: an issue closes, but "the player can double jump" must keep passing forever. Tags cover this, because they live on the playtest and the playtest outlives the issue.

Milestones, epics, sprints and the hierarchy between them are not modelled at all. They belong to the tracker. A playtest is tagged with what it proves, which rarely changes, never with when that work is scheduled, which changes all the time. Moving issue 42 from one milestone to another then touches nothing in the repo.

Goals requiring goals is replaced by tag overlap. A playtest that proves the tutorial and also guards a release carries both tags. Ordering within a group follows the playtests' own names or the run plan.

## 2. Where each piece lives

| Data | Lives in | Why |
|---|---|---|
| Playtests | The game repo, as ue-mcp test script assets | They are the spec, versioned with the code they test. Unchanged. |
| Tags, including tracker references | On the playtest asset, in the description and tags fields ue-mcp keeps (ue-mcp ask 2) | One home per playtest. A tag branches, merges and renames with the asset, so nothing can drift or dangle. |
| Runs and their provenance | The machine that ran them, as append-only records with ids unique across machines | Evidence is a fact about one machine at one revision. Immutable records upload later without reshaping. |
| Sign-off | The same evidence store, as a record: who, which tag, which revision, which runs | Acceptance is evidence, not definition. It lapses when what it signed changes, so it cannot sit in a versioned file. |
| Planning, milestones, assignees, discussion | The tracker | Already there, and only there. |

The repo gains no Studio-owned files. Nothing needs a schema, a README or a source-control writer beyond what ue-mcp already does for its own assets.

## 3. Team alignment before and after the cloud

**Before the cloud:**

- **Definitions are shared** through source control. Every teammate sees the same playtests and tags on the same branch.
- **Evidence is shared** where the team already talks. From any tag, or any run, the hub produces a short report in Markdown: status, the failing step, the revision, run ids, and a link per run. A person pastes it, or their agent posts it, into the issue the tag points at. That is how teams used CI before dashboards existed, and it works with any tracker that accepts text.
- **Every status says whose it is:** "on this computer, at a1b2c3d". Nothing pretends to be a team view.

**When the cloud arrives,** it adds one thing: a shared evidence store that each machine's records replicate into, unchanged. Statuses then read "the team, at a1b2c3d". Each tag gets a stable status URL and badge that any tracker can embed, the way CI badges work. Definitions, tags and the record format do not change, so nothing migrates. Any server-side integration the cloud product later builds sits on top, optional.

## 4. Staying tracker-agnostic

Studio never reads or writes a tracker. It touches trackers only through three things every tracker supports:

- **URLs:** a tag that is a URL renders as a link, with its host as the label.
- **Text:** reports are Markdown a person or agent pastes anywhere.
- **The project's own agent:** it already reads the tracker and records issues into playtests. Hub tools let it list tags and playtests, read status and evidence, add tags, and fetch a report. Any tracker the agent can reach works, and Studio maintains no provider code.

## 5. The design

1. A playtest is the only definition the hub has. It lives in the repo as a ue-mcp asset.
2. A playtest carries free-form tags on the asset. A URL tag is a link to anything, in any tracker.
3. The hub groups playtests by tag and computes each group's status from its playtests' health. There is no goal object and no stored hierarchy.
4. Milestones and all planning stay in the tracker. Playtests are tagged with what they prove, never with when.
5. Runs and sign-offs are immutable records on the machine that made them, with globally unique ids and provenance, behind one evidence-store interface.
6. Every status names its scope: this computer, at this revision.
7. A Markdown report from any tag or run is how evidence reaches the tracker and the team.
8. The project's agent is the tracker bridge, through hub tools: list, read, tag and report.
9. The cloud adds a shared evidence store and status URLs, replicating the same records. Nothing in the repo changes.

### What it deliberately gives up

- **Milestone roll-ups inside Studio.** "Is M3 ready?" is answered by the agent, which reads M3's issues from the tracker and asks the hub about each one, or by tagging a release set explicitly.
- **Goals requiring goals, per-goal ordering, per-goal descriptions and per-goal acceptance rules.** One project-wide health rule applies, and the description lives in the issue the tag points at.
- **Editing tags without the editor,** since they live on a UE asset. Bulk retagging means checking out each asset, which is acceptable because tags describe stable claims and are rarely bulk-edited.
- **A shared team status before the cloud.** Until then, the shared record is the reports posted to the tracker.
- **Any write-back to trackers by Studio itself,** such as comments or closing issues. People and agents do that.
