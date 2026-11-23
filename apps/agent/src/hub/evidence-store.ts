/**
 * The hub's evidence: the runs every status is worked out from, each with
 * what it tested. The hub reads and writes runs only through this interface.
 * Its one implementation is the local run index (run-index.ts), so every
 * status is this computer's view; a store shared by a team (a folder CI
 * writes, a service) would implement the same interface and answer with a
 * wider scope.
 */
import type { EvidenceScope, QaRun, RunProvenance, RunRecord, RunSource, TrackerLink } from "@ue-mcp-studio/shared";
import type { RunTimes } from "../playtest-index.js";

/** Who started a run when the hub did it: a plan's run, or a schedule's. */
export interface RunTag {
  source: RunSource;
  planRunId: string;
}

export interface EvidenceStore {
  /** Whose runs these are, for the label every status carries. */
  readonly scope: EvidenceScope["store"];
  /** A run as Studio has it now; null for what is no run of a check (a draft, inline steps, a manual run). */
  record(run: QaRun, times?: RunTimes): RunRecord | null;
  /** A run ue-mcp recorded that Studio does not hold, kept unless Studio already has a finished record of it. */
  backfill(run: QaRun, times: RunTimes): void;
  /** Mark a run the hub started as a plan's or a schedule's, now or when its record is first made. */
  tag(runId: string, tag: RunTag): void;
  /** What a run tested. Returns the record, or undefined for a run not held. */
  setProvenance(runId: string, provenance: RunProvenance): RunRecord | undefined;
  /** Project files changed while the run played (RunRecord.tainted). */
  setTainted(runId: string): RunRecord | undefined;
  /** A run's tracker links replaced; an empty list removes them. */
  setLinks(runId: string, links: TrackerLink[]): RunRecord | undefined;
  get(runId: string): RunRecord | undefined;
  /** Every run, newest first. */
  all(): RunRecord[];
  /** One check's runs, newest first. */
  byCheck(checkId: string): RunRecord[];
  /** Every check id that has runs. */
  checkIds(): string[];
  /** A page of runs, newest first, of one check or of all; `before` is a run id or an ISO time. */
  page(o: { check?: string | null; limit: number; before?: string | null }): { runs: RunRecord[]; more: boolean };
}
