# Moving the hub's machinery into ue-mcp

Do this before the hub ships. Studio is a frontend; the hub's data model and machinery are core and belong in ue-mcp (`db-lyon/ue-mcp`). This is a port of tested code, not a redesign. Product decisions are settled in [review.md](review.md) (the FINAL section), so do not reopen them.

## What moves to ue-mcp

Each item moves with its tests. Studio paths are in `C:\Users\David\Projects\UE\ue-mcp-studio`.

| Studio today | Moves to ue-mcp as |
|---|---|
| `packages/shared/src/hub.ts`, `hub-attention.ts` (types, health and status rules, goal graph, outcome mapping) | The hub contract, exported from `ue-mcp/daemon`, so clients get types and rules from one place |
| `apps/agent/src/hub/goal-store.ts`, `goal-files.ts`, `goals.ts` (store, validation, graph, export and import, one-time `QA/Goals` import) | The daemon's goal store, under the daemon's per-project data folder |
| `apps/agent/src/hub/evidence-store.ts`, `run-index.ts`, `provenance.ts`, `evidence.ts` | The daemon's evidence store and run provenance. Provenance is recorded at `script_run` itself, which also closes asks 4 and 9 |
| `apps/agent/src/hub/queue.ts`, `lease.ts`, `write-lease.ts`, `project-watch.ts` | The daemon's plan queue and editor lease (closes asks 10 to 12) |
| `apps/agent/src/hub/hub.ts`, `routes.ts` | Daemon HTTP routes, plus events (`hub.changed`) |
| `apps/agent/src/hub-tools.ts` | ue-mcp MCP tools (a `hub` category). This gives any external agent goals, plans and evidence, and needs no extension-tool hook |
| `apps/agent/src/verdict-hold.ts` (post-MVP behaviour) | The daemon, beside `script_run` (closes asks 1 and 5) |

## What stays in Studio

- **Screens:** `apps/client-web/src/views/hub/**`.
- **Client logic:** the view models, copy and API client in `packages/client-core/src/hub.ts`, which becomes a client of ue-mcp's routes.
- **The demo daemon:** `apps/client-web/src/hub-demo/**`.
- **The Experiments section** in Settings.
- **The chat-specific layer:** playtest cards in chat, the Assign-to-subagent fix loop, and the Manual/Automatic run setting. Each calls ue-mcp.
- **The Live button and viewport UI.**

## Steps

1. **In ue-mcp:** port the modules above with their tests, and expose routes, events and MCP tools. Release a ue-mcp beta.
2. **In Studio:**
   - delete the moved agent modules;
   - point client-core's hub API at ue-mcp's routes;
   - move Studio's pin to that ue-mcp beta, the same version in `apps/agent` and `apps/client-web`;
   - add a one-time import of Studio's store (`<dataDir>/hub/`) into ue-mcp's.
3. **Run** the full suites in both repos, and verify on HubPlayground (`OUTSTANDING.md` has the setup).
4. **Update** `OUTSTANDING.md` and `ue-mcp-asks.md`. Most asks close by this move.

## Cost-saving notes for the next session

- Port files rather than rewriting them, and keep their tests.
- Change nothing in the screens beyond the API base path.
- Use one implementer per repo, then one review.
