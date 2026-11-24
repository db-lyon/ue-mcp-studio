/**
 * The one-time move of Studio's old hub store into ue-mcp's: what is sent, that
 * the old files stay, and that a recorded move never repeats.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HUB_SCHEMA } from "@ue-mcp-studio/shared";
import { HUB_MOVED_FILE, hubMoved, moveHubStore, readOldStore, startHubMove } from "../src/hub-migration.js";

let dir: string;
const log = { warn: () => {} };
const end = () => ({ port: 1234, token: "t" });

const put = (folder: string, id: string, rec: Record<string, unknown>) => {
  fs.mkdirSync(path.join(dir, "hub", folder), { recursive: true });
  fs.writeFileSync(path.join(dir, "hub", folder, `${encodeURIComponent(id)}.json`), JSON.stringify(rec));
};
const rec = (type: string, id: string, extra: Record<string, unknown> = {}) => ({ schema: HUB_SCHEMA, type, id, rev: 1, at: "2026-11-01T00:00:00.000Z", origin: "o1", data: { title: id }, ...extra });

function seed() {
  fs.mkdirSync(path.join(dir, "hub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "hub", "store.json"), JSON.stringify({ schema: HUB_SCHEMA, origin: "old-origin" }));
  put("goals", "tutorial", rec("goal", "tutorial"));
  put("goals", "gone", rec("goal", "gone", { deleted: true, data: undefined }));
  put("checks", "script:/Game/A", rec("check", "script:/Game/A"));
  put("signoffs", "tutorial", rec("signoff", "tutorial"));
  put("rules", "health", rec("rules", "health"));
  put("imports", "qa", rec("import", "qa"));
  put("goals", "broken", { nope: true });
}

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-move-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readOldStore", () => {
  it("reads live records of the exported types, and names files that did not read", () => {
    seed();
    const r = readOldStore(dir);
    expect(r.origin).toBe("old-origin");
    expect(r.records.map((x) => `${x.type}:${x.id}`).sort()).toEqual(["check:script:/Game/A", "goal:tutorial", "rules:health", "signoff:tutorial"]);
    expect(r.skipped).toEqual(["goals/broken.json"]);
  });
});

describe("moveHubStore", () => {
  it("sends the records to ue-mcp's store, records the move, and leaves the old files", async () => {
    seed();
    const sent: Array<{ url: string; body: { format: string; records: unknown[] } }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ added: 4, unchanged: 0, conflicts: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await moveHubStore({ dataDir: dir, endpoint: end, log, fetchImpl })).toBe("moved");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://127.0.0.1:1234/v1/hub/store");
    expect(sent[0].body.records).toHaveLength(4);
    expect(hubMoved(dir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, HUB_MOVED_FILE), "utf-8"))).toMatchObject({ sent: 4, report: { added: 4 }, skipped: ["goals/broken.json"] });
    expect(fs.existsSync(path.join(dir, "hub", "goals", "tutorial.json"))).toBe(true);
    // Never again.
    expect(await moveHubStore({ dataDir: dir, endpoint: end, log, fetchImpl })).toBe("already");
    expect(sent).toHaveLength(1);
  });

  it("records an empty move at once when the old store has nothing", async () => {
    expect(await moveHubStore({ dataDir: dir, endpoint: end, log, fetchImpl: answer(500, {}) })).toBe("empty");
    expect(hubMoved(dir)).toBe(true);
  });

  it("records nothing while ue-mcp cannot take it, so the next start tries again", async () => {
    seed();
    expect(await moveHubStore({ dataDir: dir, endpoint: () => null, log })).toBe("later");
    expect(await moveHubStore({ dataDir: dir, endpoint: end, log, fetchImpl: answer(404, { error: "no route" }) })).toBe("later");
    expect(await moveHubStore({ dataDir: dir, endpoint: end, log, fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch })).toBe("later");
    expect(hubMoved(dir)).toBe(false);
  });

  it("records a refusal of the whole file, which asking again would not change", async () => {
    seed();
    expect(await moveHubStore({ dataDir: dir, endpoint: end, log, fetchImpl: answer(400, { error: "nothing was imported: goal x: bad" }) })).toBe("refused");
    expect(JSON.parse(fs.readFileSync(path.join(dir, HUB_MOVED_FILE), "utf-8"))).toMatchObject({ refused: "nothing was imported: goal x: bad" });
  });
});

describe("startHubMove", () => {
  it("tries again after a pause while ue-mcp cannot take it, then stops", async () => {
    seed();
    let calls = 0;
    const fetchImpl = (async () => (++calls < 2 ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ added: 4, unchanged: 0, conflicts: [] }), { status: 200 }))) as unknown as typeof fetch;
    const stop = startHubMove({ dataDir: dir, endpoint: end, log, fetchImpl }, [10, 10]);
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(calls).toBe(2);
    expect(hubMoved(dir)).toBe(true);
  });
});
