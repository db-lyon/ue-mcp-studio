import type { ReactNode } from "react";

/** Inline code with a break allowed after each dot and underscore, so a long path wraps at its parts and nowhere else. */
export function breakable(children: ReactNode): ReactNode {
  if (typeof children !== "string" || !/[._]/.test(children)) return children;
  const parts = children.split(/(?<=[._])/);
  return parts.flatMap((p, i) => (i < parts.length - 1 ? [p, <wbr key={i} />] : [p]));
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
  const parts = text.split(/(?<=\.)(?!\d)|(?<=[/\\_:,\s])|(?<==)(?!\u00a0)/).flatMap((p) => (p.trim().length > 32 ? p.split(/(?<=[a-z0-9])(?=[A-Z])/) : [p]));
  return <>{parts.map((p, i) => (i < parts.length - 1 ? [p, <wbr key={i} />] : p))}</>;
}
