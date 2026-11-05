/**
 * chat/breakable.tsx: where a long name may wrap. The web puts a <wbr> at each
 * allowed break; native text takes a zero-width space there instead.
 */
import type { ReactNode } from "react";
import { engineParts } from "@ue-mcp-studio/client-core";
export { engineParts };

const ZWSP = "\u200b";

/** Inline code with a break allowed after each dot and underscore, so a long path wraps at its parts and nowhere else. */
export function breakable(children: ReactNode): ReactNode {
  if (typeof children !== "string" || !/[._]/.test(children)) return children;
  return children.split(/(?<=[._])/).join(ZWSP);
}

/**
 * An engine name, path or value with a break allowed only between its parts:
 * after a dot (never one inside a number), slash, backslash, underscore,
 * colon, comma or equals sign (not one a no-break space follows, as in
 * "Roughness = 0.5"); and, only inside a part longer than 32 characters, where a
 * lower-case letter or digit meets a capital. Names such as
 * bCanWallRunWhileCrouched stay whole.
 */
/** An engine name with a zero-width break after each part, for a line that must wrap. */
export const engineText = (text: string): string => engineParts(text).join("​");

export function EngineText({ text }: { text: string }) {
  return <>{engineParts(text).join(ZWSP)}</>;
}
