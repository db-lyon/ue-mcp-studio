// The Git changes sheet (client-web's changes panel at phone width) and the drawer's source control chip.
const DIFF_FILE = "label=modified Source/StudioE2E/Door/DoorComponent.cpp";
const panel = { clip: ".changes-panel" };

export const GIT_PAIRS = [
  { name: "vcs-changes", web: { scenario: "vcs-changes", ...panel }, mobile: { clip: "changes-panel", presses: [DIFF_FILE] } },
  { name: "vcs-changes-remote", web: { scenario: "vcs-changes-remote", ...panel }, mobile: { clip: "changes-panel", presses: [DIFF_FILE] } },
  { name: "vcs-changes-list-narrow", web: { scenario: "vcs-changes-list-narrow", ...panel }, mobile: { clip: "changes-panel" } },
  { name: "vcs-changes-tree", web: { scenario: "vcs-changes-tree", ...panel }, mobile: { clip: "changes-panel", presses: ["Tree"] } },
  { name: "vcs-changes-tree-remote", web: { scenario: "vcs-changes-tree-remote", ...panel }, mobile: { clip: "changes-panel", presses: ["Tree"] } },
  { name: "vcs-changes-empty", web: { scenario: "vcs-changes-empty", ...panel }, mobile: { clip: "changes-panel" } },
  { name: "vcs-changes-truncated", web: { scenario: "vcs-changes-truncated", ...panel }, mobile: { clip: "changes-panel" } },
  { name: "vcs-changes-tree-collapsed", web: { scenario: "vcs-changes-tree-collapsed", ...panel }, mobile: { clip: "changes-panel", presses: ["Tree", "Collapse all"] } },
  { name: "vcs-changes-no-diff", web: { scenario: "vcs-changes-no-diff", ...panel }, mobile: { clip: "changes-panel", presses: ["label=added Content/Props/Door/Curves/C_DoorHinge.uasset"] } },
  { name: "vcs-chip-clean", web: { scenario: "vcs-changes-empty", clip: ".drawer-foot button.chip.vcs", clicks: [".bar-menu-button"] }, mobile: { clip: "vcs-chip" } },
  { name: "vcs-chip", web: { scenario: "vcs-changes-list-narrow", clip: ".drawer-foot button.chip.vcs", clicks: [".bar-menu-button"] }, mobile: { clip: "vcs-chip" } },
];
