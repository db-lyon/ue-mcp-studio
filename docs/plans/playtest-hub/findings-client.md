# Playtest Hub findings: web and mobile clients

Mapped 2026-11-22 against main at bfe3e21. Part of the [Playtest Hub plan](README.md).

**Summary.** A project-wide Playtests page already exists on web and mobile, fully built and tested. Commit ff17f07 (2026-10-26) hid it from both clients, so today a person meets playtests only as cards inside chat sessions.

## Navigation

- Tabs are `Chat | Viewport | Playtests | Plugins | Settings` (`apps/client-web/src/App.tsx:43`).
  - Playtests is filtered out of the tabs (`App.tsx:42-45`) and the drawer (`NavDrawer.tsx:8`).
  - `NavDrawer.test.tsx:54` asserts that it stays hidden.
- Routing is a URL hash: `#/chat/<id>`, `#/settings/<section>`, `#/viewport`, `#/playtests`, `#/plugins` (`packages/client-core/src/location.ts:15-32`).
  - `#/playtests` still renders the page (`App.tsx:248`), and visual QA uses it.
- One breakpoint: `max-width: 760px` (`layout.ts:8`). Narrow puts the tabs in a left `NavDrawer`, and Chat shows one pane at a time.
- `playtestsWaiting` (the count of runs that need you) is still computed and passed to the tab and drawer badge, but nobody sees it.
- Mobile mounts the page (`apps/mobile/src/AppShell.tsx:48,228`) and also leaves it out of the drawer.

## Playtests in chat today

- **The card.** A `qa` transcript entry renders `QaCard` (`chat/Transcript.tsx:94`). The pinned "Live playtests" strip was removed.
- **Leftovers.** `Chat.tsx:503-511` still computes `useSessionRuns`, which now only de-duplicates verdict forms. Mobile has the same leftover (`apps/mobile/src/views/Chat.tsx:531-536`).
- **`OutsideRuns`.** Runs started outside Studio appear in *whichever* session is open, each with Dismiss (`Qa.tsx:773-796`).
- **`FormCards`.** A verdict form with no card on screen becomes a synthetic card (`chat/Forms.tsx:25-34`).
- **Creation.**
  - `/playtest [what to test]` runs ue-mcp's playtest flow, shown as Gathering, Drafting, Checking and Created, with Retry on failure (`Transcript.tsx:125-160`).
  - The "Make playtest" pill exists but is switched off (`client-core/pill-providers.ts:43-44`, issue #115).
- **Settings.**
  - Approvals > "Starting playtests": Manual or Automatic (`ApprovalsSection.tsx:42-44`).
  - "Review each turn" is required to assign playtests.
  - Notifications `playtest.needs-you` and `playtest.finished` deep-link to the card via `focusRun` (`attention.ts:7-21`).
  - The PIN lock covers running playtests and changing scripts.

## The card (`apps/client-web/src/chat/Qa.tsx`)

One `QaCard` (`Qa.tsx:207-694`) is used in the transcript, page rows, outside runs and forms. Its button rules are client-core `cardControls` (`qa.ts:437-454`).

### Collapsed

- **Head:** eyebrow (Playtest, draft or replay), script name, and "run by <subagent>".
- **Icon buttons:** Start / Run again (with options), Stop, Assign to subagent (Continue, Try again, Assign again), End loop, Edit, Delete, Dismiss.
- **Pills:** run state (Starting, Step n of N, Needs you, Passed, n failed, Incomplete, Stopped) and loop state.
- **Step path:** one bar per step, coloured by status. A dot marks a step a person judges, and clicking a bar opens that step.
- **Summary line:** for example "5 steps: 2 passed, 1 failed, 1 needs you".
- **Ask box:** "Check in PIE: <instruction>" with Pass, Fail and Skip. Fail needs a note.
- **Assign greyed out** when every step needs a person.

### Open

- **Per step:**
  - instruction, with asset links;
  - player and judge (Observer or Person), Agent badge, status;
  - arrange/act line and expectation;
  - the evidence of a failed auto step, inline.
- **Agent verdicts:** "What the agent saw", with note and capture thumbnails, plus Override.
- **RunPanel** (`PlaytestDraft.tsx:13-45`): Start PIE, Players 1-8, Listen server, Record.
- **DraftEditor** (`PlaytestDraft.tsx:47-107`): level, and per step the instruction, player, judge and expectation. Steps can be added and removed.
- **LoopPanel** (`PlaytestLoop.tsx`):
  - headline and blocker evidence;
  - per attempt: changes, "See what it did", "Undo its changes", failing steps;
  - "Revert every attempt".
- **After the run:** a totals line and a raw `results.json` link.
- **Live updates:** `useLiveRun` applies `script.*` and `studio.qa.changed` events and re-reads after a gap (`Qa.tsx:94-134`).

## The hidden page (`views/Playtests.tsx`)

- **Header:** "Playtests", "N in this project", "k need you", Refresh.
- **Filters with counts:**
  - Active, Needs you, Failing, All;
  - the default is Active, else Needs you, else All;
  - the pick is kept in localStorage.
- **Other states:**
  - one legend for all rows;
  - an editor-offline banner with "Start the editor";
  - an empty state pointing to `/playtest` in Chat.
- **Rows:** one `PlaytestRow` per script, showing `last ?? card ?? draft`.
  - Order: needs you, active, newest, name.
  - Starting or assigning a script no session holds creates a session card first (`:170`).
- **Paging and reload:** "Show older runs" pages by 300. The page reloads 800 ms after `studio.qa.changed`, `studio.session.changed` or `studio.transcript.added`.
- **Only the newest run per script is shown.** There is no history, trend or grouping.

## Mobile and the parity gate

- **Screens.** `apps/mobile/src/screens/playtests/` mirrors the web card and page one to one: `Playtests`, `QaCard` (685 lines), `panels`, `parts`, `StepPath`, `StepText`, `OutsideRuns`, `live.ts`.
- **What `apps/mobile/test/parity-gate.test.ts` checks:**
  1. Every web visual-QA scenario in `client-web/src/visual-qa/daemon.ts` `SCENARIOS` has an entry in `apps/mobile/visual-qa/parity.ts`, with an owner or a `notOnPhone` reason longer than 20 characters.
  2. No entry names a removed scenario.
  3. Neither client redefines a name exported by `client-core` or `shared` (3 tracked exceptions).
- **What a new web view needs:**
  - visual-QA scenarios;
  - its logic and strings in client-core;
  - parity entries, which can be `notOnPhone` with a reason.

## Visual-QA playtest states (`visual-qa/fixtures.ts:1114-1146`)

- **Session:** `session-empty`, `draft`, `draft-asset-links`, `armed`, `running`, `waiting`, `waiting-open`, `focus-step-bar`, `focus-verdict`, `finished-failures(-open)`, `stopped`, `agent-captures`, `loop-running`, `loop-needs-you(-open)`, `waiting-remote`, `strip-*` (leftover names), `new-messages`.
- **Page:** `page-needs-you`, `page-failing`, `page-all`, `page-row-open`, `page-row-edit`, `page-row-delete`, `page-row-offline-open`, `page-empty`, `page-editor-offline`. There is no `page-active`.

## Design system

- **Themes:**
  - `ue-mcp`: warm dark with an orange accent;
  - `editor`: the live Slate colours through `--ue-*`;
  - `editor-orange`.
- **Tokens:** `--bg`, `--panel`, `--line`, `--text`, `--muted`, `--dim`, `--accent*`, `--ok`, `--warn`, `--bad`, `--radius`.
- **Fonts:** Plus Jakarta Sans, JetBrains Mono, and Instrument Serif for display.
- **Building blocks.** Mostly CSS classes: `.card`, `.banner`, `.pill`, `.small-button`, `.primary`, `.ghost`, `.icon-button`, `.filter-chip`, `.tab-count`, `.eyebrow`. The real components are `Sheet`, `Skeleton`, `ErrorBoundary`, settings `Row`/`Seg` and `Slot`.
- **Icons** are inline 16-unit SVG paths in each file. There is no icon library. The drawer already has a flask glyph for Playtests.
- **Layout.** Each view is `main.view-<tab>` inside `.stage`, and Chat stays mounted when hidden. The page is a 1000 px max-width column.

## UX weaknesses

1. No project-level home: the page is hidden, the count of runs that need you is never seen, and cards are scattered across sessions.
2. No run history: only the newest run per script is shown.
3. No goals or grouping above the script.
4. Thin evidence:
   - captures appear only for steps an agent judged;
   - an auto step's evidence is a hover-only tooltip;
   - results are a raw JSON link;
   - recordings and replays have no UI;
   - `actResult` is never rendered;
   - there is no logs view.
5. Session coupling: the page creates session cards behind the scenes, and outside runs appear in every session.
6. Creation is chat-only, and the DraftEditor cannot start a new script.
7. No orchestration: nothing runs several playtests or shows results across a set.
