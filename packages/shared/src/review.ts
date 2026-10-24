/**
 * Per-turn review: what a turn changed in the project, from ue-mcp's
 * checkpoints (a shadow git history the daemon keeps), with Keep or Revert per
 * item, and a timeline of the session's checkpoints. The checkpoint shapes
 * mirror the daemon's checkpoints API (db-lyon/ue-mcp#1482).
 */

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
  /** A mesh, texture or material: the diff shows a before and after picture. */
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
const VISUAL = /^(SM|SK|T|TX|M|MI|MAT|MF|MIC)_/i;

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
export function reviewGroupOf(c: Pick<CheckpointChange, "path" | "kind" | "blueprintDiff">): ReviewGroup {
  const name = c.path.split("/").pop() ?? c.path;
  if (/\.umap$/i.test(name)) return "level";
  if (c.kind === "package") return c.blueprintDiff || BLUEPRINT.test(name) ? "blueprint" : "asset";
  if (c.kind === "config") return "config";
  if (c.kind === "source") return "source";
  return "other";
}

/** A change as an item on the turn card, nobody's choice yet. */
export function reviewItemOf(c: CheckpointChange): ReviewItem {
  const group = reviewGroupOf(c);
  const asset = c.kind === "package" ? assetPathOf(c.path) : undefined;
  const name = c.path.split("/").pop() ?? "";
  return {
    path: c.path,
    status: c.status,
    kind: c.kind,
    group,
    state: "pending",
    ...(asset ? { asset } : {}),
    ...(c.untracked ? { untracked: true } : {}),
    ...(group === "asset" && VISUAL.test(name) ? { visual: true } : {}),
  };
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
