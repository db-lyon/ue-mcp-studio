/**
 * Per-turn review: what a turn changed in the project, from ue-mcp's
 * checkpoints (a shadow git history the daemon keeps), with Keep or Revert per
 * item, and a timeline of the session's checkpoints. The checkpoint shapes
 * mirror the daemon's checkpoints API (db-lyon/ue-mcp#1482).
 */

/**
 * A package's diff, built by ue-mcp on Unreal's own diff code (feature
 * "checkpoints.assetDiff", db-lyon/ue-mcp): each version loaded with
 * DiffUtils::LoadPackageForDiff and the engine's records serialized as it
 * produces them.
 */
export interface AssetDiffRecord {
  /** The engine's own message for it. */
  displayString: string;
  /** EPropertyDiffType, EDiffType or ETreeDiffType, by name. */
  diffType: string;
  /** EDiffType::Category of a graph record: ADDITION, SUBTRACTION, MODIFICATION, MINOR. */
  category?: string;
  toolTip?: string;
  /** The actor, component, variable or row a record belongs to. */
  group?: string;
  /** A difference under a property the details panel does not show. */
  hidden?: boolean;
  /** The graph nodes a graph record names, by the title the graph shows. */
  node1?: AssetDiffNode;
  node2?: AssetDiffNode;
  /** The property path, as the details panel names it. */
  path?: string;
  property?: string;
  /** Both values as FProperty::ExportText writes them; null where the property does not exist on that side. */
  before?: string | null;
  after?: string | null;
  graph?: string;
  /** The property records behind a NODE_PROPERTY graph record. */
  properties?: AssetDiffRecord[];
  /** An added or removed actor's class, label and transform. */
  facts?: AssetFact[];
}

/**
 * A graph node a record names. An added or removed node also carries what it
 * holds (asset diff format 2, db-lyon/ue-mcp#1556): its full title, its
 * visible input pins and the properties of the object behind it. An older
 * daemon sends only the first four fields.
 */
export interface AssetDiffNode {
  guid: string;
  name: string;
  class: string;
  title: string;
  fullTitle?: string;
  pins?: AssetDiffNodePin[];
  /** The class the properties are read from, such as MaterialExpressionConstant. */
  propertiesOf?: string;
  properties?: AssetDiffNodeProperty[];
  propertiesDropped?: number;
}

export interface AssetDiffNodePin {
  name: string;
  displayName: string;
  defaultValue: string;
  linked: boolean;
}

export interface AssetDiffNodeProperty {
  name: string;
  displayName: string;
  value: string;
  /** The value equals the class default. */
  isDefault: boolean;
}

/** What an added or removed node holds, in words: its properties set away from their defaults, then the defaults of its unlinked pins. */
export function nodeValues(n: AssetDiffNode | undefined): Array<{ name: string; value: string }> {
  if (!n) return [];
  const props = (n.properties ?? []).filter((p) => !p.isDefault && p.value !== "").map((p) => ({ name: p.displayName || p.name, value: p.value }));
  // A pin whose constant is already a listed property (Multiply's B is its Const B) is shown once.
  const shown = new Set((n.properties ?? []).filter((p) => !p.isDefault).flatMap((p) => [p.name, p.displayName]));
  const pins = (n.pins ?? []).filter((p) => !p.linked && p.defaultValue !== "" && !shown.has(p.displayName || p.name) && !shown.has(`Const${p.name}`)).map((p) => ({ name: p.displayName || p.name, value: p.defaultValue }));
  return [...props, ...pins];
}

/** Records under one of the engine's own diff categories. */
export interface AssetDiffSection {
  category: string;
  kind: "properties" | "graph" | "components";
  engineSource: string;
  entries: AssetDiffRecord[];
  hiddenChanges?: number;
}

export interface AssetFact {
  name: string;
  value: string;
}

export type AssetThumbnail = { id: string; url: string; source: "rendered" | "saved"; note?: string } | { error: string };

export interface AssetVersion {
  class: string;
  objectName?: string;
  facts: AssetFact[];
  thumbnail?: AssetThumbnail;
}

export interface AssetDiff {
  /** ready: diffed. deferred: over the daemon's per-call limit, diffed when asked. error: see error. */
  state: "ready" | "deferred" | "error";
  error?: string;
  packageName?: string;
  assetClass?: string;
  status?: "added" | "modified" | "deleted";
  /** Which of Unreal's diffs serves this class, and what the records are. */
  engine?: { tool: string; note: string; native: "window" | "details" | "text"; nativeAvailable?: boolean; nativeReason?: string };
  /** null: that version did not exist. */
  before?: AssetVersion | null;
  after?: AssetVersion | null;
  classChanged?: string;
  sections?: AssetDiffSection[];
  /** The engine's own text form of the diff where its diff is a text diff (a DataTable's CSV). */
  textDiff?: { format: string; diff: string };
  /** blueprint(diff)'s structural summary. */
  blueprint?: Record<string, unknown>;
  recordCount?: number;
  recordsDropped?: number;
  summary: string;
  nativeDiff: { available: boolean; reason?: string };
}

/** A changed path as the daemon lists it between two checkpoints. */
export interface CheckpointChange {
  /** Project-relative, forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted";
  kind: "package" | "config" | "source" | "other";
  /** Written outside the bridge and outside package saves, such as by the user in another program. */
  untracked?: true;
  /** Kept as a plain copy beside the shadow history, over the size cap. */
  large?: true;
  /** Unified text diff, text files only. */
  diff?: string;
  /** blueprint(diff)'s answer, Blueprint packages only, with the editor connected. */
  blueprintDiff?: Record<string, unknown>;
  /** The package's diff from Unreal's own diff code, with a picture of each version. */
  assetDiff?: AssetDiff;
}

/** How the card groups a turn's changes. */
export type ReviewGroup = "blueprint" | "level" | "asset" | "config" | "source" | "other";

export const REVIEW_GROUPS: ReadonlyArray<{ group: ReviewGroup; label: string }> = [
  { group: "blueprint", label: "Blueprints" },
  { group: "level", label: "Levels" },
  { group: "asset", label: "Assets" },
  { group: "config", label: "Config" },
  { group: "source", label: "Source" },
  { group: "other", label: "Other files" },
];

/** pending: nobody chose yet. kept: the user kept it. reverted: restored to before the turn. */
export type ReviewItemState = "pending" | "kept" | "reverted";

export interface ReviewItem {
  path: string;
  status: CheckpointChange["status"];
  kind: CheckpointChange["kind"];
  group: ReviewGroup;
  state: ReviewItemState;
  /** The asset's object path, for a package under a Content folder. */
  asset?: string;
  /** The file changed outside the agent's calls. */
  untracked?: boolean;
  /** The user edited it after the agent did: Revert refused it, and only a confirmed Revert anyway puts it back. */
  conflict?: boolean;
  /** A reverted item: the checkpoint to restore it to, to undo the revert. */
  undo?: string;
  /** One line saying what changed, to decide on without opening the item. */
  summary?: string;
  /** The package's diff failed: why. */
  diffError?: string;
  /** Whether Unreal's own diff view can open this item, and why not. */
  native?: { available: boolean; reason?: string };
  /** Reviews recorded before engine diffs: a mesh, texture or material with a picture captured after the turn. */
  visual?: boolean;
}

/** One turn's changes, bracketed by the checkpoints before and after it. */
export interface TurnReview {
  id: string;
  /** Transcript index of the message that began the turn. */
  turn: number;
  before: string;
  after: string;
  at: string;
  items: ReviewItem[];
  /** Packages still unsaved after the turn, which the checkpoint could not record. */
  dirty?: string[];
}

/** A point on the session's checkpoint timeline. */
export interface TimelineMark {
  /** The checkpoint this mark restores to. */
  checkpoint: string;
  label: string;
  at: string;
  /** turn: after a turn; restore: a restore, which can be undone; attempt: after a playtest loop attempt. */
  kind: "turn" | "restore" | "attempt";
  /** Transcript index of the turn's first message, for a turn's mark. */
  turn?: number;
  /** A restore's mark: the checkpoint taken before it, which Undo restores to. */
  undo?: string;
  /** A restore that was undone. */
  undone?: boolean;
}

/** GET /review/status: whether review can run here, and the Settings default. */
export interface ReviewStatus {
  available: boolean;
  /** Why it cannot run, when it cannot. */
  reason?: string;
  /** Settings > Agent: Review each turn, for sessions that have not set their own. */
  default: boolean;
}

/** The answer of a revert, a restore or an undo: what the daemon put back and what it refused. */
export interface RestoreOutcome {
  restored: string[];
  /** Paths the user edited after the agent: never put back without Revert anyway. */
  conflicts: string[];
  /** Paths the shadow history had no record of. */
  missing: string[];
}

/** Whether a session reviews its turns: its own switch, else the Settings default. */
export const reviewOn = (session: { review?: boolean | null }, fallback: boolean): boolean => (typeof session.review === "boolean" ? session.review : fallback);

const BLUEPRINT = /^(BP|WBP|ABP|BPI|BPFL|GA|GE|GC)_/i;

/** The object path of a package under a Content folder: Content/Props/SM_Box.uasset is /Game/Props/SM_Box.SM_Box. */
export function assetPathOf(rel: string): string | undefined {
  const p = rel.replace(/\\/g, "/");
  const m = /^(?:Plugins\/(?:.+\/)?([^/]+)\/)?Content\/(.+)\.(uasset|umap)$/i.exec(p);
  if (!m) return undefined;
  const root = m[1] ? `/${m[1]}` : "/Game";
  const name = m[2].split("/").pop()!;
  return `${root}/${m[2]}.${name}`;
}

/** The card's group for a change. */
export function reviewGroupOf(c: Pick<CheckpointChange, "path" | "kind" | "blueprintDiff" | "assetDiff">): ReviewGroup {
  const name = c.path.split("/").pop() ?? c.path;
  if (/\.umap$/i.test(name) || /(^|\/)__ExternalActors__\//.test(c.path) || c.assetDiff?.assetClass === "World") return "level";
  const engineSaysBlueprint = c.assetDiff?.engine?.tool === "SBlueprintDiff";
  if (c.kind === "package") return c.blueprintDiff || engineSaysBlueprint || BLUEPRINT.test(name) ? "blueprint" : "asset";
  if (c.kind === "config") return "config";
  if (c.kind === "source") return "source";
  return "other";
}

/** Lines added and removed in a unified diff, in words. */
export function textChangeSummary(diff: string): string {
  let added = 0;
  let removed = 0;
  for (const l of unifiedLines(diff)) {
    if (l.op === "+") added++;
    else if (l.op === "-") removed++;
  }
  const n = (k: number, w: string) => `${k} ${k === 1 ? "line" : "lines"} ${w}`;
  if (added && removed) return `${n(added, "added")}, ${removed} removed`;
  if (added) return n(added, "added");
  if (removed) return n(removed, "removed");
  return "Whitespace or line endings only";
}

/** Why a file outside Content has no view in Unreal. */
const NO_NATIVE_FOR_TEXT = "Config and source files have no diff view in Unreal; the text diff here is the whole change.";

/** The one line the card shows for a change. */
export function changeSummary(c: CheckpointChange): string {
  if (c.assetDiff) return c.assetDiff.summary;
  if (c.diff !== undefined) return textChangeSummary(c.diff);
  if (c.large) return "A large file kept as a plain copy; it is not diffed.";
  if (c.kind === "package") return "Not diffed: this ue-mcp has no asset diffs. Update ue-mcp.";
  return c.status === "added" ? "New file" : c.status === "deleted" ? "Deleted file" : "Changed file; not a text file, so there is no line diff.";
}

/** A change as an item on the turn card, nobody's choice yet. */
export function reviewItemOf(c: CheckpointChange): ReviewItem {
  const group = reviewGroupOf(c);
  const asset = c.kind === "package" ? assetPathOf(c.path) : undefined;
  const native = c.kind === "package"
    ? c.assetDiff?.nativeDiff ?? { available: false, reason: "This ue-mcp cannot open Unreal's diff. Update ue-mcp." }
    : { available: false, reason: NO_NATIVE_FOR_TEXT };
  return {
    path: c.path,
    status: c.status,
    kind: c.kind,
    group,
    state: "pending",
    ...(asset ? { asset } : {}),
    ...(c.untracked ? { untracked: true } : {}),
    summary: changeSummary(c),
    ...(c.assetDiff?.state === "error" ? { diffError: c.assetDiff.error ?? "no reason given" } : {}),
    native,
  };
}

/** Each fact of two versions side by side, by name, in the order they come. */
export function factRows(before: AssetVersion | null | undefined, after: AssetVersion | null | undefined): Array<{ name: string; before?: string; after?: string; changed: boolean }> {
  const rows = new Map<string, { name: string; before?: string; after?: string; changed: boolean }>();
  for (const f of before?.facts ?? []) rows.set(f.name, { name: f.name, before: f.value, changed: true });
  for (const f of after?.facts ?? []) {
    const r = rows.get(f.name);
    if (r) {
      r.after = f.value;
      r.changed = r.before !== f.value;
    } else rows.set(f.name, { name: f.name, after: f.value, changed: true });
  }
  if (!before || !after) for (const r of rows.values()) r.changed = false;
  return [...rows.values()];
}

/** Records by their group (actor, row, variable, component), ungrouped first, in the engine's order. */
export function recordsByGroup(entries: AssetDiffRecord[]): Array<{ group: string | null; entries: AssetDiffRecord[] }> {
  const out: Array<{ group: string | null; entries: AssetDiffRecord[] }> = [];
  for (const e of entries) {
    const g = e.group ?? null;
    const at = out.find((x) => x.group === g);
    if (at) at.entries.push(e);
    else out.push({ group: g, entries: [e] });
  }
  return out.sort((a, b) => (a.group === null ? -1 : b.group === null ? 1 : 0));
}

/** A unified diff's text as diff lines for the card's diff view. File headers are left out. */
export function unifiedLines(diff: string): Array<{ op: " " | "-" | "+"; text: string } | { op: "gap"; count: number }> {
  const out: Array<{ op: " " | "-" | "+"; text: string } | { op: "gap"; count: number }> = [];
  /** The old file's next line after the hunk read last, 1-based. */
  let next = 1;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (hunk) {
      const start = Number(hunk[1]);
      if (start > next) out.push({ op: "gap", count: start - next });
      next = start + (hunk[2] === undefined ? 1 : Number(hunk[2]));
      continue;
    }
    if (line.startsWith("+")) out.push({ op: "+", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ op: "-", text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ op: " ", text: line.slice(1) });
  }
  return out;
}

/** The fields of one struct as ExportText writes it, (A=1,B=(C=2)), split at its top level; null when the text is not one. */
function exportFields(text: string): Map<string, string> | null {
  const items = exportItems(text);
  if (!items) return null;
  const out = new Map<string, string>();
  for (const it of items) {
    const eq = it.indexOf("=");
    if (eq <= 0) return null;
    out.set(it.slice(0, eq), it.slice(eq + 1));
  }
  return out;
}

/** The top-level items of a parenthesised ExportText list, quotes and nesting respected; null when it is not one. */
function exportItems(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return null;
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 1;
  for (let i = 1; i < t.length - 1; i++) {
    const c = t[i];
    if (c === '"' && t[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      items.push(t.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) return null;
  }
  if (depth !== 0 || quoted) return null;
  items.push(t.slice(start, t.length - 1));
  return items.filter((x) => x !== "");
}

/** A float as ExportText writes it, 0.500000, as 0.5. */
export const exportNumber = (v: string): string => (/^-?\d+\.\d+$/.test(v) ? String(Number(v)) : v);

/** A material parameter's value in words: a number, a colour, an asset's path, or the text as it is. */
function parameterValue(raw: string): string {
  const v = raw.trim();
  const color = exportFields(v);
  if (color && ["R", "G", "B", "A"].every((k) => color.has(k)) && color.size === 4) return `(R\u00a0${exportNumber(color.get("R")!)}, G\u00a0${exportNumber(color.get("G")!)}, B\u00a0${exportNumber(color.get("B")!)}, A\u00a0${exportNumber(color.get("A")!)})`;
  // An object reference: "/Script/Engine.Texture2D'/Game/T_Rock.T_Rock'" or Texture2D'/Game/T_Rock.T_Rock'.
  const ref = /^"?[\w/.]+'([^']+)'"?$/.exec(v);
  if (ref) return ref[1].replace(/\/([^/.]+)\.\1$/, "/$1");
  return exportNumber(v.replace(/^"(.*)"$/, "$1"));
}

/**
 * A material parameter struct, or a list of them, as ExportText writes it
 * (a material instance's Scalar Parameter Values, say), in words: "Roughness =
 * 0.5, Tint = (R 1, G 0, B 0, A 1)". Null for any other value, which is shown
 * as the engine wrote it.
 */
export function readableValue(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t.includes("ParameterInfo=")) return null;
  const one = (s: string): string | null => {
    const f = exportFields(s);
    const info = f?.get("ParameterInfo");
    const name = info ? exportFields(info)?.get("Name") : undefined;
    const value = f?.get("ParameterValue") ?? f?.get("Value");
    if (!name || value === undefined) return null;
    return `${name.replace(/^"(.*)"$/, "$1")} = ${parameterValue(value)}`;
  };
  const single = one(t);
  if (single) return single;
  const items = exportItems(t);
  if (!items?.length) return null;
  const parts = items.map(one);
  return parts.every((p): p is string => p !== null) ? parts.join(", ") : null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const clip = (v: string, max = 60): string => {
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};

/** A record in a line, its values in words where the engine wrote a struct. */
function recordLine(r: AssetDiffRecord): string {
  const label = r.path ? (r.group && r.group !== r.path ? `${r.group} ${r.path}` : r.path) : r.displayString;
  if (!r.path || (r.before === undefined && r.after === undefined)) return r.displayString;
  const v = (x: string | null | undefined) => (x === null || x === undefined ? "none" : clip(readableValue(x) ?? x));
  if (r.diffType === "PropertyAddedToB") return `${label} added: ${v(r.after)}`;
  if (r.diffType === "PropertyAddedToA") return `${label} removed: ${v(r.before)}`;
  return `${label} ${v(r.before)} to ${v(r.after)}`;
}

/**
 * A package's diff as the card shows it. A Blueprint variable is reported by
 * the engine twice, under My Blueprint and again as the class default it
 * declares: the Defaults record is dropped so the variable counts once. When
 * that, or a struct value put in words, changes what the one-line summary
 * says, the summary is written again from the records.
 */
export function refineAssetDiff(d: AssetDiff): AssetDiff {
  if (d.state !== "ready" || !d.sections?.length) return d;
  const variables = new Set(d.sections.filter((s) => s.category === "My Blueprint").flatMap((s) => s.entries.map((e) => e.group).filter((g): g is string => !!g)));
  let folded = 0;
  const sections = d.sections.flatMap((s) => {
    if (s.category !== "Defaults" || variables.size === 0) return [s];
    const entries = s.entries.filter((e) => {
      const twice = !e.group && variables.has(e.property ?? e.path ?? "");
      if (twice) folded++;
      return !twice;
    });
    if (entries.length === s.entries.length) return [s];
    return entries.length ? [{ ...s, entries, hiddenChanges: entries.filter((e) => e.hidden).length }] : [];
  });
  const all = sections.flatMap((s) => s.entries);
  const visible = all.filter((r) => !r.hidden);
  const reworded = visible.some((r) => readableValue(r.before) !== null || readableValue(r.after) !== null);
  if (!folded && !reworded) return d;
  const out: AssetDiff = { ...d, sections, ...(d.recordCount !== undefined ? { recordCount: d.recordCount - folded } : {}) };
  if (d.status !== "modified" || visible.length === 0) return out;
  const lines: string[] = [];
  for (const r of visible) {
    const line = recordLine(r);
    if (!lines.includes(line)) lines.push(line);
    if (lines.length === 2) break;
  }
  const hidden = all.length - visible.length;
  const total = visible.length + (d.recordsDropped ?? 0);
  const rest = total - lines.length;
  out.summary = `${plural(total, "difference")}: ${lines.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}${hidden ? `; plus ${plural(hidden, "difference")} in properties the details panel does not show` : ""}`;
  return out;
}
