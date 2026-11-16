/**
 * What both clients say around Studio's version check: while the computer has
 * not yet answered whether this ue-mcp can run Studio, and on the screen that
 * says it cannot. Every state offers a way on: check again, open Studio
 * anyway, or leave for another project.
 */

/** How long the check may take before the waiting screen offers a way on. */
export const REFUSAL_WAIT_MS = 8000;
/** The waiting screen's line while the check runs. */
export const REFUSAL_PENDING = "Checking that this ue-mcp can run Studio";
/** The waiting screen's line once the check has taken longer than it should. */
export const REFUSAL_SLOW = "Studio has not answered yet. ue-mcp may still be starting.";
export const REFUSAL_CHECK_AGAIN = "Check again";
export const REFUSAL_OPEN_ANYWAY = "Open Studio anyway";
export const REFUSAL_BACK = "Back to projects";
/** After Check again found the same refusal. */
export const refusalStill = (needs: string): string => `Checked again: Studio still needs ue-mcp ${needs}.`;
/** After Update installed ue-mcp on the computer. */
export const refusalInstalled = (version: string): string => `ue-mcp ${version} is installed. Restart the editor to finish, then check again.`;
