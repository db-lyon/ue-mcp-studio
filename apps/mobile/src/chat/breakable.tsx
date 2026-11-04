/**
 * chat/breakable.tsx: where a long name may wrap. The web puts a <wbr> at each
 * allowed break; native text takes a zero-width space there instead.
 */
import type { ReactNode } from "react";

const ZWSP = "\u200b";

/** Inline code with a break allowed after each dot and underscore, so a long path wraps at its parts and nowhere else. */
export function breakable(children: ReactNode): ReactNode {
  if (typeof children !== "string" || !/[._]/.test(children)) return children;
  return children.split(/(?<=[._])/).join(ZWSP);
}

/** The parts of an engine name, path or value between which it may break (EngineText's rule). */
export function engineParts(text: string): string[] {
  return text.split(/(?<=\.)(?!\d)|(?<=[/\_:,\s])|(?<==)(?!\u00a0)/).flatMap((p) => (p.trim().length > 32 ? p.split(/(?<=[a-z0-9])(?=[A-Z])/) : [p]));
}

/**
 * An engine name, path or value with a break allowed only between its parts:
 * after a dot (never one inside a number), slash, backslash, underscore,
 * colon, comma or equals sign (not one a no-break space follows, as in
 * "Roughness = 0.5"); and, only inside a part longer than 32 characters, where a
 * lower-case letter or digit meets a capital. Names such as
 * bCanWallRunWhileCrouched stay whole.
 */
export function EngineText({ text }: { text: string }) {
  return <>{engineParts(text).join(ZWSP)}</>;
}
