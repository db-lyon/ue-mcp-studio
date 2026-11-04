/**
 * An engine name, path or value that may break only between its parts (see
 * client-core's engineParts): a zero-width space marks each place, as <wbr>
 * does in the web client. Inside a Text it is a string, so it nests.
 */
import { engineParts } from "@ue-mcp-studio/client-core";

const ZWSP = "​";

/** The text with a break allowed only between its parts. */
export const engineText = (text: string): string => engineParts(text).join(ZWSP);

export function EngineText({ text }: { text: string }) {
  return <>{engineText(text)}</>;
}
