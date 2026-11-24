/**
 * The Playtest Hub's contract and the playtest run model: types, the rules
 * that work out health and status, the goal graph, the Needs attention list
 * and the QaRun functions. They live in ue-mcp beside the hub that serves
 * them, so every client gets them from one place. This file only hands them
 * to Studio's two clients through `@ue-mcp-studio/shared`.
 *
 * `ue-mcp/hub` loads only the contract, so the page and the phone app can
 * bundle it. ue-mcp installs once, at the workspace root, for every package
 * here. A name Studio declares itself in index.ts (its own BusyState, for
 * one) is Studio's and wins over the hub's of the same name.
 */
export * from "ue-mcp/hub";
