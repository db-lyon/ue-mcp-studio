/**
 * The editor's state as the shell mounts it (web: views/EditorBanner.tsx):
 * compact, the narrow top bar's chip that opens the banner under the bar;
 * otherwise the full banner. The words and rules are client-core's editor.ts.
 */
import type { DaemonState } from "../state";
import { EditorBanner as FullBanner, EditorChip } from "../screens/editor/EditorChip";

export { BUSY_AFTER_MS, callLabel, failureLine, formatElapsed, operationLine, stepFailed } from "@ue-mcp-studio/client-core";

export function EditorBanner({ compact = false }: { daemon?: DaemonState; compact?: boolean }) {
  return compact ? <EditorChip /> : <FullBanner />;
}
