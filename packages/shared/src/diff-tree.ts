/**
 * A package's diff as a tree grid, for every client: sections at the root,
 * then the object, widget, node or actor a record belongs to, then the
 * property path, each change one row with its before and after values. A
 * level that holds only one thing is folded into its child's label, so one
 * widget property reads "Widget WardMeter > Hide when Full" on one row. No
 * React and no DOM: the web client and the app render the same rows.
 */
import { exportFields, exportItems, exportNumber, factRows, nodeValues, readableParts, type AssetDiff, type AssetDiffRecord, type AssetDiffSection, type AssetVersion } from "./review.js";

/** What a row's change is: added, removed, changed, or minor (a node moved). */
export type DiffTone = "add" | "del" | "mod" | "minor";

/** The glyph a row's change shows before its name, and the word it stands for. */
export const TONE_GLYPH: Record<DiffTone, string> = { add: "+", del: "−", mod: "~", minor: "·" };
export const TONE_WORD: Record<DiffTone, string> = { add: "Added", del: "Removed", mod: "Changed", minor: "Minor" };

/** EDiffType::Category and the diff types, in words. */
export const CHANGE_KIND: Record<string, string> = {
  ADDITION: "Added",
  SUBTRACTION: "Removed",
  MODIFICATION: "Changed",
  MINOR: "Minor",
  OBJECT_ADDED: "Added",
  OBJECT_REMOVED: "Removed",
  NODE_ADDED: "Added",
  NODE_REMOVED: "Removed",
  NODE_TYPE_CHANGED: "Changed",
  NODE_PROPERTY_CHANGED: "Changed",
  NODE_MOVED: "Moved",
  PropertyAddedToA: "Removed",
  PropertyAddedToB: "Added",
  PropertyValueChanged: "Changed",
};

export const kindOf = (r: AssetDiffRecord): string => CHANGE_KIND[r.category ?? ""] ?? CHANGE_KIND[r.diffType] ?? "Changed";
export const toneOf = (r: AssetDiffRecord): DiffTone => {
  const k = kindOf(r);
  return k === "Added" ? "add" : k === "Removed" ? "del" : k === "Minor" || k === "Moved" ? "minor" : "mod";
};

/** The node a graph record is about, by the title the graph shows. */
export const nodeOf = (r: AssetDiffRecord): string | undefined => r.node2?.title ?? r.node1?.title;

/** An added or removed node's subtitle: its full title, when it says more than its name (spaces aside) and its values already do. */
export function nodeSubtitle(r: AssetDiffRecord): string | null {
  if (r.diffType !== "NODE_ADDED" && r.diffType !== "NODE_REMOVED") return null;
  const n = r.node1 ?? r.node2;
  const full = n?.fullTitle?.replace(/\s*\n\s*/g, ", ");
  const bare = (x: string) => x.replace(/\s+/g, "").toLowerCase();
  return full && bare(full) !== bare(n!.title) && !r.displayString.includes(full) && !nodeValues(n).some((v) => exportNumber(v.value) === full) ? full : null;
}

/** The engine's message without the verb the row's glyph already says: "Added Node Branch" reads "Node Branch". */
export function withoutVerb(text: string, tone: DiffTone): string {
  const verb = tone === "add" ? /^Added\s+/ : tone === "del" ? /^Removed\s+/ : null;
  return verb && verb.test(text) ? text.replace(verb, "").replace(/^\w/, (c) => c.toUpperCase()) : text;
}

/** A struct of numbers as ExportText writes it, (X=1200.000000,Y=-280.000000,Z=0.000000), as "X 1200, Y -280, Z 0"; null for any other text. */
export function numberStruct(v: string): string | null {
  const m = /^\(([^()]*)\)$/.exec(v.trim());
  if (!m) return null;
  const parts = m[1].split(",").map((p) => /^\s*(\w+)=(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*$/i.exec(p));
  if (!parts.length || parts.some((p) => !p)) return null;
  const rgba = ["R", "G", "B", "A"];
  if (parts.every((p) => rgba.includes(p![1])) && parts.length >= 3) parts.sort((a, b) => rgba.indexOf(a![1]) - rgba.indexOf(b![1]));
  return parts.map((p) => `${p![1]} ${Number(p![2])}`).join(", ");
}

const toSrgb = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
};

/**
 * The CSS colour of a colour value as ExportText writes it: an FLinearColor,
 * (R=0.5,G=0.1,B=0,A=1), converted from linear, or an FColor, (B=0,G=0,R=255,A=255).
 * Null for any other text.
 */
export function colorOf(text: string): string | null {
  const m = /^\(([^()]*)\)$/.exec(text.trim());
  if (!m) return null;
  const f = new Map<string, number>();
  for (const part of m[1].split(",")) {
    const kv = /^\s*([RGBA])=(-?\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!kv) return null;
    f.set(kv[1], Number(kv[2]));
  }
  if (!["R", "G", "B"].every((k) => f.has(k)) || f.size !== m[1].split(",").length) return null;
  const linear = /\./.test(m[1]);
  const [r, g, b] = ["R", "G", "B"].map((k) => (linear ? toSrgb(f.get(k)!) : Math.min(255, Math.max(0, Math.round(f.get(k)!)))));
  const a = f.has("A") ? Math.min(1, Math.max(0, linear ? f.get("A")! : f.get("A")! / 255)) : 1;
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

/** A value as a cell shows it. */
export interface DiffValue {
  /** As the engine wrote it, for the hover. */
  raw: string;
  /** On one line, in words where the engine wrote a struct. Empty for an empty value. */
  text: string;
  /** A value of several lines or items (text, an array, a parameter list): each one, for the cell opened in place. */
  lines: string[] | null;
  /** The CSS colour of a colour value, for a swatch beside its text. */
  color: string | null;
  /** Too long for its cell, or several lines: the cell opens in place to show all of it. */
  long: boolean;
}

/** Characters a value may have before its cell offers to open in place. */
export const LONG_VALUE = 28;

/** A value as a cell shows it: in words where it can be, one line, with its lines when it has several. */
export function diffValue(raw: string): DiffValue {
  const parts = readableParts(raw);
  const multiline = /\n/.test(raw) ? raw.replace(/\r\n/g, "\n").split("\n") : null;
  const color = colorOf(raw);
  const struct = numberStruct(raw);
  const fields = !parts && !color && !struct ? exportFields(raw) : null;
  // A struct of one field, (TagName="Spawn.Gate"), is that field's value.
  if (fields && fields.size === 1) {
    const one = diffValue([...fields.values()][0].replace(/^"(.*)"$/, "$1"));
    return { ...one, raw };
  }
  const items = !parts && !multiline && !color && !struct && !fields ? exportItems(raw) : null;
  // A list: several items, or one quoted string, ("Gate").
  const list = items && (items.length > 1 || /^".*"$/.test(items[0] ?? "")) ? items.map((i) => exportNumber(i.replace(/^"(.*)"$/, "$1"))) : null;
  const lines = parts && parts.length > 1 ? parts : multiline ?? list;
  // An object reference, /Script/Engine.BlueprintGeneratedClass'/Game/Enemies/BP_Orc.BP_Orc_C', is its asset's path.
  const ref = /^"?[\w/.]+'([^']+)'"?$/.exec(raw.trim());
  const text = parts ? parts.join(", ") : list ? list.join(", ") : multiline ? multiline.map((l) => l.trim()).filter(Boolean).join(" ↵ ") : ref ? ref[1].replace(/\/([^/.]+)\.\1(?:_C)?$/, "/$1") : struct ?? exportNumber(raw);
  return { raw, text, lines, color, long: !!lines || text.length > LONG_VALUE };
}

/**
 * The named parts a value opens into as rows of its own: a material
 * parameter list's parameters by name, a struct's fields, or a list of structs
 * by index. Null for a value shown in its cell: a number, a colour, a vector,
 * a name, a list of names.
 */
export function valueFields(raw: string | null | undefined): Array<[string, string]> | null {
  if (!raw) return null;
  const t = raw.trim();
  if (colorOf(t) || numberStruct(t)) return null;
  const param = (item: string): [string, string] | null => {
    const f = exportFields(item);
    const info = f?.get("ParameterInfo");
    const name = info ? exportFields(info)?.get("Name") : undefined;
    const value = f?.get("ParameterValue") ?? f?.get("Value");
    return name && value !== undefined ? [name.replace(/^"(.*)"$/, "$1"), value] : null;
  };
  if (t.includes("ParameterInfo=")) {
    const single = param(t);
    if (single) return [single];
    const items = exportItems(t)?.map(param);
    if (items?.length && items.every((x): x is [string, string] => !!x)) return items;
  }
  const fields = exportFields(t);
  if (fields && fields.size > 1) return [...fields.entries()];
  const items = exportItems(t);
  if (items?.length && items.every((i) => /^\(.*\)$/.test(i.trim()))) return items.map((i, n) => [`[${n}]`, i]);
  return null;
}

/**
 * A value's fields as child rows: with both versions, only the fields that
 * differ, each a change; with one, every field on its side. Null when neither
 * version opens into fields.
 */
function fieldRows(id: string, tone: DiffTone, before: string | null | undefined, after: string | null | undefined, depth = 0): DiffTreeRow[] | null {
  if (depth > 3) return null;
  const b = tone === "add" ? null : valueFields(before);
  const a = tone === "del" ? null : valueFields(after);
  if (tone === "mod" ? !b || !a : !(b ?? a)) return null;
  const names = [...new Set([...(b ?? []).map(([k]) => k), ...(a ?? []).map(([k]) => k)])];
  const bm = new Map(b ?? []);
  const am = new Map(a ?? []);
  const out: DiffTreeRow[] = [];
  for (const name of names) {
    const bv = bm.get(name);
    const av = am.get(name);
    if (tone === "mod" && bv === av) continue;
    const t: DiffTone | null = tone !== "mod" ? null : bv === undefined ? "add" : av === undefined ? "del" : "mod";
    const rid = `${id}/f:${name}`;
    const kids = fieldRows(rid, t ?? tone, bv, av, depth + 1);
    out.push({
      id: rid, label: [name], tone: t, children: kids ?? [], count: 0,
      ...(t === null ? { detail: true } : {}),
      ...(kids ? {} : sides(t ?? tone, bv, av)),
    });
  }
  return out;
}

/** One row of the tree: a section, a group (an object, widget, node or actor, or a step of a property path), or a change. */
export interface DiffTreeRow {
  /** Unique in the tree, and the same each time the same diff is built. */
  id: string;
  /** The row's name, a level per part: more than one where single-child levels were folded into it. */
  label: string[];
  /** The change the row is; null for a section, a group or a fact. */
  tone: DiffTone | null;
  /** The value before and after; absent where that side has nothing to show (an added row's Before). */
  before?: DiffValue;
  after?: DiffValue;
  /** A side the property did not exist on, for a changed row: shown as "none". */
  beforeNone?: boolean;
  afterNone?: boolean;
  /** Said after the name, dimmed: an added node's full title. */
  note?: string;
  /** The hover on the name: the engine's own message and the property's path. */
  title?: string;
  children: DiffTreeRow[];
  /** Changes under the row, the row included: a group's count. */
  count: number;
  /** A section: a root of the tree. */
  section?: boolean;
  /** A value an added or removed node or actor holds: not a change of its own. */
  detail?: boolean;
  /** Closed until opened: differences the details panel does not show, the facts of a one-version asset beside its tile. */
  closed?: boolean;
}

/** A property path split at its levels: "Waves[0].Spawns[2].Count" is Waves[0], Spawns[2], Count. A dot between digits or inside brackets is not a level. */
export function pathLevels(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === "." && !(/\d/.test(path[i - 1] ?? "") && /\d/.test(path[i + 1] ?? ""))) {
      out.push(path.slice(start, i));
      start = i + 1;
    } else if (depth === 0 && path.startsWith(" > ", i)) {
      out.push(path.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  out.push(path.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

interface Trie {
  key: string;
  label: string;
  row?: Omit<DiffTreeRow, "id" | "label" | "children" | "count">;
  details?: Array<{ name: string; value: string; side: "before" | "after" }>;
  /** A record's values, to open into field rows. */
  fields?: { tone: DiffTone; before: string | null | undefined; after: string | null | undefined };
  children: Map<string, Trie>;
}

const trie = (key: string, label: string): Trie => ({ key, label, children: new Map() });

/** The level under `t` keyed `key`, made where it is missing. */
function level(t: Trie, key: string, label: string): Trie {
  let c = t.children.get(key);
  if (!c) {
    c = trie(key, label);
    t.children.set(key, c);
  }
  return c;
}

/** A row's place, made fresh where the same place already holds a row. */
function place(t: Trie, keys: Array<[string, string]>): Trie {
  let at = t;
  keys.forEach(([key, label], i) => {
    if (i < keys.length - 1) {
      at = level(at, key, label);
      return;
    }
    let k = key;
    for (let n = 2; at.children.get(k)?.row; n++) k = `${key}#${n}`;
    at = level(at, k, label);
  });
  return at;
}

const value = (v: string | null | undefined): DiffValue | undefined => (v === null || v === undefined ? undefined : diffValue(v));

/** A record's two values as the row shows them: an added row only After, a removed one only Before. */
function sides(tone: DiffTone, before: string | null | undefined, after: string | null | undefined) {
  return {
    ...(tone !== "add" && before !== undefined ? (before === null ? { beforeNone: true } : { before: value(before) }) : {}),
    ...(tone !== "del" && after !== undefined ? (after === null ? { afterNone: true } : { after: value(after) }) : {}),
  };
}

const titleOf = (r: AssetDiffRecord, name: string): string | undefined => {
  const lines = [...new Set([r.displayString, r.toolTip, r.path && r.path !== name ? r.path : undefined].filter((x): x is string => !!x && x !== name))];
  return lines.length ? lines.join("\n") : undefined;
};

/** "Pin 'then' has more links (was 0 now 1)": the message and its two numbers. */
const WAS_NOW = /^(.*?)\s*\(was (.+?) now (.+?)\)\s*$/;

/** A graph record into the tree: under its node, its node itself where the node was added or removed. */
function addGraphRecord(root: Trie, r: AssetDiffRecord) {
  const tone = toneOf(r);
  const node = r.node1 ?? r.node2;
  const nodeKey: [string, string] | null = node ? [`n:${node.guid || node.title}`, node.title] : null;
  if ((r.diffType === "NODE_ADDED" || r.diffType === "NODE_REMOVED") && nodeKey) {
    const t = level(root, nodeKey[0], nodeKey[1]);
    const side = tone === "del" ? "before" : "after";
    const values = nodeValues(node).map((v) => ({ name: v.name, value: v.value, side } as const));
    const dropped = node!.propertiesDropped ?? 0;
    const note = [nodeSubtitle(r), dropped ? `${dropped} more properties not listed` : null].filter(Boolean).join("; ");
    t.row = { tone, title: r.displayString, ...(note ? { note } : {}) };
    t.details = values;
    return;
  }
  // A graph record that only says its node's properties changed is those properties, under the node.
  if (r.properties?.length && r.before === undefined && r.after === undefined && (r.diffType === "NODE_PROPERTY" || r.diffType === "OBJECT_PROPERTY")) {
    const under = nodeKey ? level(root, ...nodeKey) : root;
    for (const p of r.properties) addPropertyRecord(under, p);
    return;
  }
  const keys: Array<[string, string]> = nodeKey ? [nodeKey] : [];
  if (r.diffType === "PIN_DEFAULT_VALUE" && (r.pin1 || r.pin2)) {
    const pin = (r.pin2 ?? r.pin1)!.name;
    const t = place(root, [...keys, [`p:${pin}`, pin]]);
    t.row = { tone, title: r.displayString, ...sides(tone, r.pin1?.defaultValue, r.pin2?.defaultValue) };
    return;
  }
  if (r.diffType === "NODE_MOVED") {
    const t = place(root, [...keys, ["moved", "Moved"]]);
    t.row = { tone, title: r.displayString };
    return;
  }
  const wasNow = WAS_NOW.exec(r.displayString);
  const text = withoutVerb(wasNow ? wasNow[1] : r.displayString, tone);
  const links = /^Pin '(.+)' has (?:more|fewer) links$/.exec(text);
  const t = place(root, links ? [...keys, [`pin:${links[1]}`, links[1]], ["links", "Links"]] : [...keys, [`m:${text}`, text]]);
  t.row = {
    tone,
    ...(links ? { title: r.displayString } : {}),
    ...(r.toolTip && r.toolTip !== r.displayString ? { title: r.toolTip } : {}),
    ...(r.before !== undefined || r.after !== undefined ? sides(tone, r.before, r.after) : wasNow ? sides(tone, wasNow[2], wasNow[3]) : {}),
  };
  if (r.properties?.length) for (const p of r.properties) addPropertyRecord(t, p);
}

/** A property record into the tree: its group (actor, component, widget, variable), then each level of its path. */
function addPropertyRecord(root: Trie, r: AssetDiffRecord) {
  const tone = toneOf(r);
  const named = r.label ?? r.path;
  // An added or removed actor or object: the group is the row, what it holds its details.
  if (named === undefined && r.group && (r.diffType === "OBJECT_ADDED" || r.diffType === "OBJECT_REMOVED" || tone === "add" || tone === "del")) {
    const t = level(root, `g:${r.group}`, r.group);
    t.row = { tone, title: r.displayString };
    const side = tone === "del" ? "before" : "after";
    t.details = (r.facts ?? []).map((f) => ({ name: f.name, value: f.value, side }));
    return;
  }
  const levels = named !== undefined ? pathLevels(named) : [withoutVerb(r.displayString, tone)];
  const keys: Array<[string, string]> = levels.map((l, i) => [`p:${levels.slice(0, i + 1).join(".")}`, l]);
  // A variable added under My Blueprint names itself as its group: one level, not two.
  if (r.group && !(levels.length === 1 && levels[0] === r.group)) keys.unshift([`g:${r.group}`, r.group]);
  const t = place(root, keys);
  t.row = { tone, title: titleOf(r, levels[levels.length - 1]), ...(valueFields(r.before) || valueFields(r.after) ? {} : sides(tone, r.before, r.after)) };
  t.fields = { tone, before: r.before, after: r.after };
  if (r.properties?.length) for (const p of r.properties) addPropertyRecord(t, p);
}

/** The trie as rows, a level with one child and no change of its own folded into that child. */
function rowsOf(t: Trie, parent: string): DiffTreeRow[] {
  return [...t.children.values()].map((c) => rowOf(c, parent));
}

function rowOf(t: Trie, parent: string): DiffTreeRow {
  const id = `${parent}/${t.key}`;
  if (!t.row && t.children.size === 1 && !t.details?.length) {
    const only = rowOf([...t.children.values()][0], id);
    return { ...only, label: [t.label, ...only.label] };
  }
  const details: DiffTreeRow[] = (t.details ?? []).map((d, i) => ({
    id: `${id}/d:${i}`,
    label: [d.name],
    tone: null,
    detail: true,
    children: [],
    count: 0,
    ...(d.side === "before" ? { before: diffValue(d.value) } : { after: diffValue(d.value) }),
  }));
  const fields = t.fields ? fieldRows(id, t.fields.tone, t.fields.before, t.fields.after) : null;
  // A value that would open into rows but whose versions did not both (a struct beside an empty one) stays in its cells.
  const row = t.row && t.fields && !fields && !t.row.before && !t.row.after ? { ...t.row, ...sides(t.fields.tone, t.fields.before, t.fields.after) } : t.row;
  const children = [...details, ...(fields ?? []), ...rowsOf(t, id)];
  const own = row?.tone ? 1 : 0;
  return { tone: null, ...row, id, label: [t.label], children, count: own + children.reduce((n, c) => n + c.count, 0) };
}

/** A section of records as the root rows' children: graph records by node, the rest by group and path. */
function recordRows(entries: AssetDiffRecord[], graph: boolean, parent: string): DiffTreeRow[] {
  const root = trie("", "");
  for (const r of entries) {
    if (graph || r.node1 || r.node2) addGraphRecord(root, r);
    else addPropertyRecord(root, r);
  }
  return rowsOf(root, parent);
}

/** Words for the differences the details panel does not show, as a group of their own. */
export const HIDDEN_GROUP = "Not in the details panel";

/** One of the engine's sections as a root row: what the details panel shows, then a closed group of what it does not. */
export function sectionRow(s: AssetDiffSection): DiffTreeRow {
  const id = `s:${s.category}`;
  const shown = s.entries.filter((e) => !e.hidden);
  const hidden = s.entries.filter((e) => e.hidden);
  const children = recordRows(shown, s.kind === "graph", id);
  if (hidden.length) {
    const hid = `${id}/hidden`;
    const rows = recordRows(hidden, s.kind === "graph", hid);
    children.push({ id: hid, label: [HIDDEN_GROUP], tone: null, children: rows, count: rows.reduce((n, c) => n + c.count, 0), closed: shown.length > 0, title: "Properties Unreal keeps but its details panel does not list" });
  }
  return {
    id,
    label: [s.category],
    tone: null,
    section: true,
    title: [`From Unreal's ${s.engineSource}`, ...(s.notes ?? [])].join("\n"),
    children,
    count: children.reduce((n, c) => n + (c.id.endsWith("/hidden") ? 0 : c.count), 0),
  };
}

/**
 * Facts the engine records already show: a variable's fact when My Blueprint
 * lists that variable, and the count of variables, components or graphs when
 * that section has records.
 */
export function coveredFacts(sections: AssetDiffSection[]): Set<string> {
  const out = new Set<string>();
  for (const s of sections) {
    if (!s.entries.some((e) => !e.hidden)) continue;
    if (s.category === "My Blueprint") {
      out.add("Variables");
      for (const e of s.entries) if (e.group) out.add(`Variable ${e.group}`);
    }
    if (s.category === "Components") out.add("Components");
    for (const e of s.entries) {
      const kind = /^(Scalar|Vector|Texture) Parameter Values$/.exec(e.path ?? "");
      if (kind) out.add(`${kind[1]} parameter`);
    }
    if (s.category.startsWith("Graph: ")) out.add("Graphs");
    if (s.category === "Material Graph") out.add("Expressions");
  }
  return out;
}

/** Section names for an asset's facts. */
export const FACTS_SECTION = "Facts";
export const ONE_VERSION_SECTION = "Details of this version";

/**
 * Facts about each version as a root row. With both versions, only the facts
 * that differ and that no record already shows; with one, its facts, closed
 * when its tile beside the tree already shows some. Null where there is
 * nothing to add: no fact, or no more than the tile lists.
 */
export function factsRow(before: AssetVersion | null | undefined, after: AssetVersion | null | undefined, covered: Set<string>, tile: { shown: boolean; facts: number }): DiffTreeRow | null {
  const rows = factRows(before, after);
  if (!before || !after) {
    if (rows.length === 0 || (tile.shown && rows.length <= tile.facts)) return null;
    const id = "s:version";
    return {
      id, label: [ONE_VERSION_SECTION], tone: null, section: true, closed: tile.shown, count: 0,
      children: rows.map((r) => ({ id: `${id}/${r.name}`, label: [r.name], tone: null, detail: true, children: [], count: 0, ...(before ? { before: diffValue(r.before ?? "") } : { after: diffValue(r.after ?? "") }) })),
    };
  }
  const isCovered = (name: string) => covered.has(name) || [...covered].some((c) => / parameter$/.test(c) && name.startsWith(`${c} `));
  const changed = rows.filter((r) => r.changed && !isCovered(r.name));
  if (changed.length === 0 || (tile.shown && changed.length <= tile.facts)) return null;
  const id = "s:facts";
  return {
    id, label: [FACTS_SECTION], tone: null, section: true, count: changed.length,
    children: changed.map((r) => ({
      id: `${id}/${r.name}`, label: [r.name], children: [], count: 1,
      ...(r.before === undefined ? { tone: "add" as const, after: diffValue(r.after ?? "") } : r.after === undefined ? { tone: "del" as const, before: diffValue(r.before) } : { tone: "mod" as const, before: diffValue(r.before), after: diffValue(r.after) }),
    })),
  };
}

/** A ready diff as the tree's root rows: each engine section, then the facts. */
export function diffTree(diff: AssetDiff, tile: { shown: boolean; facts: number } = { shown: false, facts: 0 }): DiffTreeRow[] {
  const sections = diff.sections ?? [];
  const roots = sections.filter((s) => s.entries.length > 0).map(sectionRow);
  const facts = factsRow(diff.before, diff.after, coveredFacts(sections), tile);
  if (facts) roots.push(facts);
  return roots;
}

/** A row as the grid lays it out: its depth, and whether it is open. */
export interface DiffTreeLine {
  row: DiffTreeRow;
  depth: number;
  /** A row with children: open shows them. */
  open: boolean;
}

/** Whether a row is open: as it starts (open, unless it starts closed), unless the reader toggled it. */
export const isOpen = (row: DiffTreeRow, toggled: ReadonlySet<string>): boolean => (row.closed ? toggled.has(row.id) : !toggled.has(row.id));

/** The lines the grid shows: every row whose parents are all open, in order. */
export function treeLines(roots: DiffTreeRow[], toggled: ReadonlySet<string>, depth = 0): DiffTreeLine[] {
  const out: DiffTreeLine[] = [];
  for (const row of roots) {
    const open = row.children.length > 0 && isOpen(row, toggled);
    out.push({ row, depth, open });
    if (open) out.push(...treeLines(row.children, toggled, depth + 1));
  }
  return out;
}

/** The separator a folded label is joined with. */
export const LABEL_JOIN = " › ";

/** A row's value cells on one line, for a narrow card: "False → True", "+ True", "− 0.2". */
export function inlineChange(row: Pick<DiffTreeRow, "before" | "after" | "beforeNone" | "afterNone">): string {
  const b = row.before ? row.before.text || "empty" : row.beforeNone ? "none" : null;
  const a = row.after ? row.after.text || "empty" : row.afterNone ? "none" : null;
  return b !== null && a !== null ? `${b} → ${a}` : b ?? a ?? "";
}

/** Rough pixel metrics of a row, for inlineFits: a name's and a value's character, a level's indent, and the triangle and glyph before a name. */
export interface RowMetrics {
  label: number;
  value: number;
  indent: number;
  lead: number;
}

/** The web client's 12px grid. */
export const WEB_ROW_METRICS: RowMetrics = { label: 6.6, value: 6.9, indent: 14, lead: 28 };

/**
 * Whether a row's name and its values fit on one line of a narrow card this
 * wide, so a short "Mobility  Static → Movable" or "Class  PointLight" takes one
 * line instead of two. A guess on the safe side: a row it lets through that
 * does not fit wraps.
 */
export function inlineFits(row: DiffTreeRow, depth: number, width: number, m: RowMetrics = WEB_ROW_METRICS): boolean {
  if (row.children.length || !(row.before || row.after || row.beforeNone || row.afterNone)) return false;
  const value = inlineChange(row);
  const both = !!(row.before || row.beforeNone) && !!(row.after || row.afterNone);
  const name = row.label.join(LABEL_JOIN);
  const used = 6 + depth * m.indent + m.lead + name.length * m.label + 14 + (value.length - (both ? 3 : 0)) * m.value + (both ? 3 * m.value : 0) + 12;
  return value.length > 0 && used <= width;
}

/**
 * Whether a row's two values need a line each on a narrow card: together on
 * one line under the name, each would be cut to half the width, hiding the
 * part that differs.
 */
export function splitNeeded(row: DiffTreeRow, depth: number, width: number, m: RowMetrics = WEB_ROW_METRICS): boolean {
  if (!(row.before || row.beforeNone) || !(row.after || row.afterNone)) return false;
  const room = width - 6 - depth * m.indent - m.lead - 12;
  return inlineChange(row).length * m.value > room;
}
