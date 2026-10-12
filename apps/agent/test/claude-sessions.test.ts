import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { activeElsewhere, claudeCodeRows, importSession, migrateHome, projectSessions, writtenElsewhere } from "../src/claude-sessions.js";

const ID = "2f01f625-aefc-4d24-80f3-5a941d67cac5";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const info = (over: Partial<SDKSessionInfo> = {}): SDKSessionInfo => ({ sessionId: ID, summary: "Vale world-gen resume", lastModified: NOW - 3_600_000, createdAt: NOW - 7_200_000, ...over });
const msg = (type: SessionMessage["type"], content: unknown, parent: string | null = null): SessionMessage =>
  ({ type, uuid: "u", session_id: ID, message: { role: type, content }, parent_tool_use_id: parent, parent_agent_id: null });

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cs-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("sessions shared with Claude Code", () => {
  it("lists the project's sessions through the SDK, and none when it cannot read them", async () => {
    const seen: unknown[] = [];
    expect(await projectSessions("C:/P/Vale", async (o) => (seen.push(o), [info()]))).toHaveLength(1);
    expect(seen).toEqual([{ dir: "C:/P/Vale" }]);
    expect(await projectSessions("C:/P/Vale", async () => { throw new Error("no home"); })).toEqual([]);
  });

  it("shows the ones Studio does not hold, titled the way Claude Code titles them", () => {
    const rows = claudeCodeRows([info({ customTitle: "Renamed" }), info({ sessionId: "other", lastModified: NOW - 5_000 })], new Set(["other"]), NOW);
    expect(rows).toEqual([expect.objectContaining({ id: ID, title: "Renamed", origin: "claude-code", status: "idle" })]);
    expect(rows[0].activeElsewhere).toBeUndefined();
    expect(claudeCodeRows([info({ lastModified: NOW - 5_000 })], new Set(), NOW)[0].activeElsewhere).toBe(true);
  });

  it("opens one as a Studio session on the same conversation, main thread only", async () => {
    const lines = [
      msg("user", "Resume world-gen work."),
      msg("assistant", [{ type: "text", text: "Checking HEAD." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "git rev-parse HEAD" } }]),
      msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "f45e720" }]),
      msg("assistant", [{ type: "text", text: "subagent chatter" }], "t9"),
      msg("assistant", [{ type: "tool_use", id: "t2", name: "mcp__studio__ue_mcp", input: { action: "search" } }]),
    ];
    const s = (await importSession("C:/P/Vale", info(), async () => lines))!;
    expect(s).toMatchObject({ id: ID, sdkSession: ID, title: "Vale world-gen resume", status: "idle" });
    expect(s.transcript.map((t) => t.kind)).toEqual(["user", "assistant", "tool", "tool"]);
    const calls = s.transcript.flatMap((t) => (t.kind === "tool" ? [t.call] : []));
    expect(calls[0]).toMatchObject({ name: "Bash", result: "f45e720", outcome: "done" });
    expect(calls[1]).toMatchObject({ name: "ue_mcp" });
    expect(JSON.stringify(s)).not.toContain("subagent chatter");
    expect(await importSession("C:/P/Vale", info(), async () => [])).toBeNull();
    expect(await importSession("C:/P/Vale", info(), async () => { throw new Error("gone"); })).toBeNull();
  });

  it("counts a session as open elsewhere only when something else wrote it after Studio", () => {
    const saved = "2026-10-12T11:59:00Z";
    expect(writtenElsewhere(Date.parse("2026-10-12T11:59:05Z"), saved)).toBe(false);
    expect(writtenElsewhere(Date.parse("2026-10-12T11:59:50Z"), saved)).toBe(true);
    expect(activeElsewhere(NOW - 5_000, saved, NOW)).toBe(true);
    expect(activeElsewhere(NOW - 5_000, "2026-10-12T11:59:58Z", NOW)).toBe(false);
    expect(activeElsewhere(undefined, saved, NOW)).toBe(false);
  });

  it("moves Studio's old home over once, keeping the shared sign-in", () => {
    const old = tmp();
    const home = tmp();
    const t = path.join("projects", "C--P-Vale", `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(path.join(old, t)), { recursive: true });
    fs.writeFileSync(path.join(old, t), "{}\n");
    fs.writeFileSync(path.join(old, ".credentials.json"), "old");
    fs.writeFileSync(path.join(home, ".credentials.json"), "shared");
    migrateHome(old, home);
    expect(fs.existsSync(path.join(home, t))).toBe(true);
    expect(fs.readFileSync(path.join(home, ".credentials.json"), "utf-8")).toBe("shared");
    fs.rmSync(path.join(home, t));
    migrateHome(old, home);
    expect(fs.existsSync(path.join(home, t))).toBe(false);
  });

  it("brings the sign-in over when the shared home has none", () => {
    const old = tmp();
    const home = tmp();
    fs.writeFileSync(path.join(old, ".credentials.json"), "old");
    migrateHome(old, home);
    expect(fs.readFileSync(path.join(home, ".credentials.json"), "utf-8")).toBe("old");
  });
});
