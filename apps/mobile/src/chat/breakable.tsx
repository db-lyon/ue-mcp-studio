/**
 * chat/breakable.tsx: where a long name may wrap. The web puts a <wbr> at each
 * allowed break; native text takes a zero-width space there instead. Where an
 * engine name may break is client-core's engineParts.
 */
import type { ReactNode } from "react";
import { engineParts } from "@ue-mcp-studio/client-core";

const ZWSP = "\u200b";

export { engineParts };

/** Inline code with a break allowed after each dot and underscore, so a long path wraps at its parts and nowhere else. */
export function breakable(children: ReactNode): ReactNode {
  if (typeof children !== "string" || !/[._]/.test(children)) return children;
  return children.split(/(?<=[._])/).join(ZWSP);
}

/** An engine name, path or value with a break allowed only between its parts. Inside a Text it is a string, so it nests. */
export const engineText = (text: string): string => engineParts(text).join(ZWSP);

export function EngineText({ text }: { text: string }) {
  return <>{engineText(text)}</>;
}
