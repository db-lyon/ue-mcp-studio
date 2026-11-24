/**
 * The one-time move of Studio's own Playtest Hub store into ue-mcp's.
 *
 * Before the hub moved into ue-mcp, Studio kept goals, what each playtest
 * says about itself, sign-offs and the health rule as one JSON file per record
 * under <dataDir>/hub/ (dataDir is the extension's data folder). They are read
 * here and handed to ue-mcp's POST /v1/hub/store, which merges by id: a record
 * ue-mcp lacks is added, one it has is left as it is. Nothing is deleted or
 * changed in the old folder. Run history and the queue are per computer and
 * are not part of an export; ue-mcp fills history from the runs it has on disk.
 *
 * The result is recorded in <dataDir>/hub-moved.json, so the import never
 * repeats. A daemon that cannot take it now (no hub route, not reachable)
 * records nothing and the import is tried again at the next start.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { HUB_EXPORT_FORMAT, HUB_SCHEMA, type AnyHubRecord, type HubExport, type HubImportReport, type HubRecordType } from "@ue-mcp-studio/shared";
import { writeFileAtomic } from "./atomic-write.js";
import type { DaemonEndpoint } from "./playtest-flow.js";

/** The record folders an export carries, by type. Removed records and import markers stay behind. */
const FOLDERS: ReadonlyArray<readonly [HubRecordType, string]> = [
  ["goal", "goals"],
  ["check", "checks"],
  ["signoff", "signoffs"],
  ["rules", "rules"],
];

/** The record of the move, written beside the old store and never inside it. */
export const HUB_MOVED_FILE = "hub-moved.json";

export interface HubMoved {
  at: string;
  /** What ue-mcp did with the records; absent when there were none to send or it refused the file. */
  report?: HubImportReport;
  /** How many records were sent. */
  sent: number;
  /** Why nothing was imported, when ue-mcp refused the file. */
  refused?: string;
  /** Files in the old store that could not be read, so a person can look at them. */
  skipped?: string[];
}

export type HubMoveResult = "already" | "moved" | "empty" | "refused" | "later";

export interface HubMoveOptions {
  /** The extension's data folder, whose hub/ folder is the old store. */
  dataDir: string;
  endpoint: () => DaemonEndpoint | null;
  log: { warn(message: string, detail?: unknown): void };
  now?: () => string;
  fetchImpl?: typeof fetch;
}

/** What the old store holds: every live record of the exported types, and the files that did not read. */
export function readOldStore(dataDir: string): { origin: string; records: AnyHubRecord[]; skipped: string[] } {
  const dir = path.join(dataDir, "hub");
  const records: AnyHubRecord[] = [];
  const skipped: string[] = [];
  let origin = "studio";
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf-8")) as { origin?: unknown };
    if (typeof saved.origin === "string" && saved.origin) origin = saved.origin;
  } catch {
    // No store file: records carry their own origin.
  }
  for (const [type, folder] of FOLDERS) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, folder)).filter((n) => n.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names) {
      const where = `${folder}/${name}`;
      try {
        const id = decodeURIComponent(name.slice(0, -".json".length));
        const r = JSON.parse(fs.readFileSync(path.join(dir, folder, name), "utf-8")) as Partial<AnyHubRecord> | null;
        if (!r || typeof r !== "object" || r.type !== type || r.id !== id || r.schema !== HUB_SCHEMA) skipped.push(where);
        else if (r.deleted !== true) records.push(r as AnyHubRecord);
      } catch {
        skipped.push(where);
      }
    }
  }
  return { origin, records, skipped };
}

const movedPath = (dataDir: string): string => path.join(dataDir, HUB_MOVED_FILE);

/** Whether the move was recorded. */
export function hubMoved(dataDir: string): boolean {
  return fs.existsSync(movedPath(dataDir));
}

/** How long after start the move is tried again while ue-mcp cannot take it: a daemon still coming up, or one with no hub yet. */
const RETRY_MS: readonly number[] = [5_000, 30_000, 120_000];

/** Try the move now and again after a pause while it is "later". Returns the function that stops trying. */
export function startHubMove(o: HubMoveOptions, retryMs: readonly number[] = RETRY_MS): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const attempt = (n: number) => {
    void moveHubStore(o)
      .then((r) => {
        if (r === "later" && !stopped && n < retryMs.length) {
          timer = setTimeout(() => attempt(n + 1), retryMs[n]);
          timer.unref();
        }
      })
      .catch((e: unknown) => o.log.warn("hub: moving Studio's old goals failed", e));
  };
  attempt(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Move Studio's old hub store into ue-mcp's, once. */
export async function moveHubStore(o: HubMoveOptions): Promise<HubMoveResult> {
  if (hubMoved(o.dataDir)) return "already";
  const iso = o.now ?? (() => new Date().toISOString());
  const record = (moved: Omit<HubMoved, "at">) => writeFileAtomic(movedPath(o.dataDir), `${JSON.stringify({ at: iso(), ...moved }, null, 2)}\n`);
  const { origin, records, skipped } = readOldStore(o.dataDir);
  const rest = skipped.length ? { skipped } : {};
  if (records.length === 0) {
    record({ sent: 0, ...rest });
    return "empty";
  }
  const end = o.endpoint();
  if (!end) return "later";
  const file: HubExport = { format: HUB_EXPORT_FORMAT, schema: HUB_SCHEMA, exportedAt: iso(), origin, records };
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(`http://127.0.0.1:${end.port}/v1/hub/store`, {
      method: "POST",
      headers: { authorization: `Bearer ${end.token}`, "content-type": "application/json" },
      body: JSON.stringify(file),
    });
  } catch (e) {
    o.log.warn("hub: the old store could not be sent to ue-mcp yet", e);
    return "later";
  }
  const body = (await res.json().catch(() => null)) as (Partial<HubImportReport> & { error?: unknown }) | null;
  if (res.status === 400) {
    // The file as a whole does not read: asking again would answer the same.
    const refused = typeof body?.error === "string" ? body.error : "ue-mcp refused the file";
    o.log.warn(`hub: ue-mcp refused Studio's old goals: ${refused}`);
    record({ sent: records.length, refused, ...rest });
    return "refused";
  }
  if (!res.ok || typeof body?.added !== "number") {
    o.log.warn(`hub: ue-mcp could not take Studio's old goals yet (${res.status})`);
    return "later";
  }
  record({ sent: records.length, report: { added: body.added, unchanged: body.unchanged ?? 0, conflicts: Array.isArray(body.conflicts) ? body.conflicts : [] }, ...rest });
  return "moved";
}
