/**
 * A faked daemon checkpoints API (db-lyon/ue-mcp#1482): a project as a map of
 * path to contents, checkpoints as snapshots of it, changes between two
 * snapshots, and restore with the daemon's refusals and its before and after
 * checkpoints.
 */
import type { CheckpointChange } from "@ue-mcp-studio/shared";
import type { CheckpointApi, CheckpointResult, CheckpointState, ChangesResult, RestoreResult } from "../src/review.js";

const kindOf = (p: string): CheckpointChange["kind"] => (/\.(uasset|umap)$/i.test(p) ? "package" : /\.ini$/i.test(p) ? "config" : /\.(cpp|h|cs)$/i.test(p) ? "source" : "other");

export class FakeCheckpoints implements CheckpointApi {
  /** The project on disk. */
  files = new Map<string, string>();
  enabled = false;
  source: "config" | "session" = "session";
  /** Unsaved packages the next checkpoint reports. */
  dirty: string[] = [];
  /** Paths the user edited after the agent: restore refuses them unless forced. */
  editedOutside = new Set<string>();
  /** Fail the next create, once. */
  failCreate: Error | null = null;
  readonly snapshots = new Map<string, { label: string; files: Map<string, string>; trigger: CheckpointResult["trigger"] }>();
  readonly log: string[] = [];
  private n = 0;

  private id(): string {
    this.n++;
    return this.n.toString(16).padStart(40, "0");
  }

  private snap(label: string, trigger: CheckpointResult["trigger"]): CheckpointResult {
    const id = this.id();
    this.snapshots.set(id, { label, files: new Map(this.files), trigger });
    return { editor: "P", id, label, createdAt: new Date(0).toISOString(), trigger, files: 0, changes: [], dirtyPackages: [...this.dirty], editorConnected: true };
  }

  private diff(from: Map<string, string>, to: Map<string, string>): CheckpointChange[] {
    const out: CheckpointChange[] = [];
    for (const p of new Set([...from.keys(), ...to.keys()])) {
      const a = from.get(p);
      const b = to.get(p);
      if (a === b) continue;
      const status = a === undefined ? "added" : b === undefined ? "deleted" : "modified";
      const kind = kindOf(p);
      out.push({ path: p, status, kind, ...(kind !== "package" ? { diff: `--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n-${a ?? ""}\n+${b ?? ""}` } : {}) });
    }
    return out.sort((x, y) => x.path.localeCompare(y.path));
  }

  async state(): Promise<CheckpointState> {
    this.log.push("state");
    return { editor: "P", enabled: this.enabled, source: this.source, configured: false, repository: null, checkpoints: [] };
  }

  async setEnabled(enabled: boolean | null): Promise<CheckpointState> {
    this.log.push(`setEnabled ${enabled}`);
    this.enabled = enabled === true;
    return { editor: "P", enabled: this.enabled, source: this.source, configured: false, repository: null, checkpoints: [] };
  }

  async create(label = ""): Promise<CheckpointResult> {
    if (this.failCreate) {
      const e = this.failCreate;
      this.failCreate = null;
      throw e;
    }
    if (!this.enabled) throw new Error("checkpoints are off");
    this.log.push(`create ${label}`);
    return this.snap(label, "client");
  }

  async changes(from: string, to?: string): Promise<ChangesResult> {
    const a = this.snapshots.get(from);
    if (!a) throw new Error(`unknown checkpoint ${from}`);
    const b = to ? this.snapshots.get(to)?.files : this.files;
    if (!b) throw new Error(`unknown checkpoint ${to}`);
    return { editor: "P", from, to: to ?? null, changes: this.diff(a.files, b) };
  }

  async restore(checkpoint: string, opts: { paths?: string[]; force?: boolean } = {}): Promise<RestoreResult> {
    const at = this.snapshots.get(checkpoint);
    if (!at) throw new Error(`unknown checkpoint ${checkpoint}`);
    this.log.push(`restore ${checkpoint.replace(/^0+/, "")} ${(opts.paths ?? ["*"]).join(",")}${opts.force ? " force" : ""}`);
    const before = this.snap("restore-before", "restore-before");
    const paths = opts.paths ?? [...new Set([...at.files.keys(), ...this.files.keys()])];
    const restored: RestoreResult["restored"] = [];
    const refused: RestoreResult["refused"] = [];
    for (const p of paths) {
      if (this.editedOutside.has(p) && !opts.force) {
        refused.push({ path: p, reason: "edited-outside" });
        continue;
      }
      const v = at.files.get(p);
      if (v === this.files.get(p)) continue;
      if (v === undefined) {
        this.files.delete(p);
        restored.push({ path: p, action: "deleted" });
      } else {
        this.files.set(p, v);
        restored.push({ path: p, action: "written" });
      }
      this.editedOutside.delete(p);
    }
    const after = this.snap("restore-after", "restore-after");
    return { editor: "P", checkpoint, before: before.id, after: after.id, restored, refused, reloaded: [], unloaded: [], configsReloaded: [], reopened: [] };
  }
}
