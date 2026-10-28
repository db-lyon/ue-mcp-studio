/** The session store's own rules, apart from any turn. */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/sessions.js";

const agent = (id: string, outcome: "pending" | "done" | "error" | "stopped") =>
  ({ kind: "tool" as const, call: { id, name: "agent", input: { description: id }, outcome, startedAt: "t" } });

describe("dismissed subagents", () => {
  it("takes only finished agent calls off the list, once each, and keeps them across a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-sess-"));
    try {
      const store = new SessionStore(dir);
      const s = store.create();
      s.transcript.push(agent("run", "pending"), agent("ok", "done"), agent("bad", "error"), { kind: "tool", call: { id: "sh", name: "shell", input: {}, outcome: "done", startedAt: "t" } });
      expect(SessionStore.dismiss(s, ["run", "ok", "sh", "nope"])).toEqual(["ok"]);
      expect(SessionStore.dismiss(s, ["ok", "bad", "bad"])).toEqual(["bad"]);
      store.save(s);
      const again = new SessionStore(dir).get(s.id)!;
      expect(SessionStore.detail(again).dismissed).toEqual(["ok", "bad"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("blank sessions (#140)", () => {
  const files = (dir: string) => fs.readdirSync(path.join(dir, "sessions")).filter((f) => f.endsWith(".json"));

  it("are not written until they have content, and New hands back the blank one there is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-sess-"));
    try {
      const store = new SessionStore(dir);
      const a = store.blank();
      expect(store.blank().id).toBe(a.id);
      expect(store.all().map((s) => s.id)).toEqual([a.id]);
      expect(files(dir)).toEqual([]);
      a.draft = "Check the jump";
      store.save(a);
      expect(files(dir)).toEqual([`${a.id}.json`]);
      // A session with a draft is not blank: New makes another, kept in memory only.
      const b = store.blank();
      expect(b.id).not.toBe(a.id);
      expect(files(dir)).toEqual([`${a.id}.json`]);
      const again = new SessionStore(dir);
      expect(again.all().map((s) => s.id)).toEqual([a.id]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("left on disk by an earlier version are removed on load, and a cleared draft takes the file away", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-sess-"));
    try {
      const store = new SessionStore(dir);
      const kept = store.create();
      kept.transcript.push({ kind: "user", text: "hello", at: "t" });
      store.save(kept);
      const stale = { ...kept, id: "stale", title: "New session", transcript: [] };
      fs.writeFileSync(path.join(dir, "sessions", "stale.json"), JSON.stringify(stale));
      const drafted = store.create();
      drafted.draft = "x";
      store.save(drafted);
      drafted.draft = "";
      store.save(drafted);
      const again = new SessionStore(dir);
      expect(again.all().map((s) => s.id)).toEqual([kept.id]);
      expect(files(dir)).toEqual([`${kept.id}.json`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
