/** A PIE test script run as ue-mcp answers it, from plans/qa-checklist-contract.md. */
export const RUN = "script_DoorOpens_20261023_100000";
export const RESULTS = `C:/MyGame/Saved/MCPObservations/${RUN}/results.json`;

/** The pie(script_run) answer from the contract. */
export const runAnswer = () => ({
  success: true,
  run_id: RUN,
  script: "/Game/PIEStudio/Scripts/DoorOpens",
  script_name: "DoorOpens",
  state: "armed",
  current_step: 0,
  results_path: RESULTS,
  steps: [
    { index: 0, instruction: "Walk up to the door", judge: "auto", expect: { value: "Door.Distance", op: "decreasing", within_ms: 3000 }, status: "pending", within_ms: 3000 },
    { index: 1, instruction: "Open the door", judge: "auto", expect: { value: "Door.OpenAngle", op: "gt", target: 80 }, status: "pending", within_ms: 5000 },
    { index: 2, instruction: "The door opens without a visible pop", judge: "manual", status: "pending", within_ms: 5000 },
  ],
  awaiting: [],
  events: [{ seq: 1, type: "run_started", run_id: RUN, step: -1, at_ms: 0, wall_time: "2026-10-23T15:00:00.000Z", data: { script: "/Game/PIEStudio/Scripts/DoorOpens", steps: 3 } }],
  last_seq: 1,
  summary: { total: 3, passed: 0, failed: 0, skipped: 0, pending: 3, awaiting: 0 },
});

