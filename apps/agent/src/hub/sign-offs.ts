/**
 * Sign-offs, kept on this computer in <dataDir>/hub/sign-offs.json beside the
 * runs they judged, one per goal: a sign-off is evidence about this
 * machine's runs at one revision, not part of what the goal asks for, so it
 * never goes into the goal file or source control. Its lapse is worked out
 * on every read (shared signOffLapse), never stored.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SignOff } from "@ue-mcp-studio/shared";
import { writeFileAtomic } from "../atomic-write.js";

export class SignOffStore {
  private readonly file: string;
  private readonly byGoal = new Map<string, SignOff>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "hub", "sign-offs.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf-8")) as unknown;
      for (const s of Array.isArray(saved) ? saved : []) if (isSignOff(s)) this.byGoal.set(s.goalId, s);
    } catch {
      // None given on this computer yet.
    }
  }

  all(): ReadonlyMap<string, SignOff> {
    return this.byGoal;
  }

  get(goalId: string): SignOff | undefined {
    return this.byGoal.get(goalId);
  }

  /** Record a sign-off, replacing the goal's earlier one. */
  set(s: SignOff): void {
    this.byGoal.set(s.goalId, s);
    this.save();
  }

  /** Forget a goal's sign-off. Returns whether it had one. */
  clear(goalId: string): boolean {
    if (!this.byGoal.delete(goalId)) return false;
    this.save();
    return true;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify([...this.byGoal.values()], null, 2)}\n`);
  }
}

function isSignOff(v: unknown): v is SignOff {
  const s = v as Partial<SignOff> | null;
  return !!s && typeof s.goalId === "string" && typeof s.by === "string" && typeof s.at === "string" && Array.isArray(s.runIds) && typeof s.requirements === "string" && (typeof s.revision === "string" || s.revision === null);
}
