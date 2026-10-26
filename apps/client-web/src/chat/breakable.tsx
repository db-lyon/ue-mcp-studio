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
 * colon, comma or equals sign; and, inside a part longer than 16 characters,
 * where a lower-case letter or digit meets a capital. A narrow card then wraps
 * BP_PlayerCharacterMovementComponent.uasset at its parts, while a short name
 * such as MossCoverage stays whole.
 */
export function EngineText({ text }: { text: string }) {
  const parts = text.split(/(?<=\.)(?!\d)|(?<=[/\\_:,=\s])/).flatMap((p) => (p.trim().length > 16 ? p.split(/(?<=[a-z0-9])(?=[A-Z])/) : [p]));
  return <>{parts.map((p, i) => (i < parts.length - 1 ? [p, <wbr key={i} />] : p))}</>;
}
