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
