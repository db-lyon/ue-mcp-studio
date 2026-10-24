import type { ReactNode } from "react";

/** Inline code with a break allowed after each dot and underscore, so a long path wraps at its parts and nowhere else. */
export function breakable(children: ReactNode): ReactNode {
  if (typeof children !== "string" || !/[._]/.test(children)) return children;
  const parts = children.split(/(?<=[._])/);
  return parts.flatMap((p, i) => (i < parts.length - 1 ? [p, <wbr key={i} />] : [p]));
}
