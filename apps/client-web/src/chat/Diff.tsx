import type { DiffLine } from "@ue-mcp-studio/shared";

/**
 * A line diff: removed lines in red, added in green, left-out unchanged runs as one dim line.
 * Each line is its sign in a gutter and its text beside it, so a line that wraps on a narrow
 * panel continues under its text, right of the gutter, never under the sign.
 */
export function DiffView({ lines, label }: { lines: DiffLine[]; label?: string }) {
  if (lines.length === 0) return <pre className="output diff dim">No change.</pre>;
  return (
    <pre className="output diff" aria-label={label}>
      {lines.map((l, i) =>
        l.op === "gap"
          ? <span key={i} className="diff-gap">{`  ${l.count} unchanged ${l.count === 1 ? "line" : "lines"}\n`}</span>
          : (
            <span key={i} className={`diff-line ${l.op === "+" ? "diff-add" : l.op === "-" ? "diff-del" : "diff-ctx"}`}>
              <span className="diff-op" aria-hidden={l.op === " " || undefined}>{`${l.op} `}</span>
              <span className="diff-text">{`${l.text}\n`}</span>
            </span>
          ),
      )}
    </pre>
  );
}
