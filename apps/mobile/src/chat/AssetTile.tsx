// STUB: owned by transcript
/** The tile a review shows for an asset version with no picture: its class, status, path, what changed and its facts. */
import type { ReactNode } from "react";
import { View } from "react-native";
import type { AssetDiff, AssetDiffSection, AssetVersion } from "@ue-mcp-studio/shared";
import { T, useTheme } from "../ui";

/** How many facts the tile lists. */
export const TILE_FACTS = 4;

const STATUS_LINE: Record<"added" | "modified" | "deleted", string> = { added: "New in this turn", modified: "Changed in this turn", deleted: "Deleted in this turn" };

export function AssetTile({ cls, fileName, path, status, changes, facts, note }: {
  cls?: string;
  fileName: string;
  path?: string;
  status: "added" | "modified" | "deleted";
  changes?: Array<{ text: string; tone: string }>;
  facts?: Array<{ name: string; value: string; was?: string }>;
  note?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View accessibilityRole="none" accessibilityLabel={`${cls ?? "Asset"} ${fileName}`} style={{ paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.line, borderLeftWidth: 3, borderLeftColor: t.c.accentLine, borderRadius: 4, gap: 4 }}>
      <T weight={600}>{cls ?? "Asset"} <T size={12} tone={status === "added" ? "ok" : status === "deleted" ? "bad" : "muted"}>{STATUS_LINE[status]}</T></T>
      {path ? <T role="mono" size={11} tone="muted">{path}</T> : null}
      {changes?.length ? <T size={12} tone="muted">{changes.map((c) => c.text).join(", ")}</T> : null}
      {(facts ?? []).map((f) => (
        <T key={f.name} size={12} tone="muted">
          {f.name} <T role="mono" size={11}>{f.was !== undefined ? `${f.was} to ` : ""}{f.value}</T>
        </T>
      ))}
      {note ? <T size={12} tone="dim">{note}</T> : null}
    </View>
  );
}

function changeCounts(sections: AssetDiffSection[] | undefined): Array<{ text: string; tone: string }> {
  const n = (sections ?? []).reduce((k, s) => k + s.entries.filter((e) => !e.hidden).length, 0);
  return n ? [{ text: `${n} ${n === 1 ? "change" : "changes"}`, tone: "mod" }] : [];
}

function tileFacts(before: AssetVersion | null | undefined, after: AssetVersion | null | undefined, max = TILE_FACTS) {
  const main = after ?? before;
  return main ? main.facts.slice(0, max).map((f) => ({ name: f.name, value: f.value })) : [];
}

/** The tile's facts for a package diff. */
export function tileOf(diff: AssetDiff, fileName: string, path: string | undefined, status: "added" | "modified" | "deleted") {
  return {
    cls: diff.assetClass ?? diff.after?.class ?? diff.before?.class,
    fileName,
    path: path ?? diff.packageName,
    status,
    changes: changeCounts(diff.sections),
    facts: tileFacts(diff.before, diff.after),
  };
}
