import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeElsewhere, claudeCodeSessions, importTranscript, migrateHome, projectKey, transcriptsDir, writtenElsewhere } from "../src/claude-sessions.js";

const ID = "2f01f625-aefc-4d24-80f3-5a941d67cac5";
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cs-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const lines = [
  { type: "user", timestamp: "2026-10-12T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "Resume world-gen work.\nMore detail." }] } },
  { type: "assistant", timestamp: "2026-10-12T10:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "Checking HEAD." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "git rev-parse HEAD" } }] } },
  { type: "user", timestamp: "2026-10-12T10:00:06Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "f45e720" }] } },
  { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
  { type: "assistant", timestamp: "2026-10-12T10:00:09Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "mcp__studio__ue_mcp", input: { action: "search" } }] } },
  { type: "ai-title", aiTitle: "Vale world-gen resume" },
];

function project(home: string, projectDir: string, id = ID, content = lines) {
  const dir = transcriptsDir(home, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), content.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path.join(dir, `${id}.jsonl`);
}

describe("sessions shared with Claude Code", () => {
  it("finds the project's folder the way Claude names it", () => {
    expect(projectKey("C:\\Users\\david\\Projects\\UE\\Vale")).toBe("C--Users-david-Projects-UE-Vale");
  });

  it("lists the project's Claude Code sessions Studio does not hold, titled", () => {
    const home = tmp();
    const proj = path.join(tmp(), "Vale");
    project(home, proj);
    const [s] = claudeCodeSessions(home, proj, new Set());
    expect(s).toMatchObject({ id: ID, title: "Vale world-gen resume", origin: "claude-code", status: "idle" });
    expect(claudeCodeSessions(home, proj, new Set([ID]))).toEqual([]);
  });

  it("skips a transcript with nothing the user said", () => {
    const home = tmp();
    const proj = path.join(tmp(), "Vale");
    project(home, proj, ID, [{ type: "queue-operation" } as never]);
    expect(claudeCodeSessions(home, proj, new Set())).toEqual([]);
  });

  it("opens one as a Studio session on the same conversation, main thread only", () => {
    const home = tmp();
    const proj = path.join(tmp(), "Vale");
    project(home, proj);
    const s = importTranscript(home, proj, ID)!;
    expect(s.id).toBe(ID);
    expect(s.sdkSession).toBe(ID);
    expect(s.transcript.map((t) => t.kind)).toEqual(["user", "assistant", "tool", "tool"]);
    const calls = s.transcript.filter((t) => t.kind === "tool").map((t) => (t.kind === "tool" ? t.call : null));
    expect(calls[0]).toMatchObject({ name: "Bash", result: "f45e720", outcome: "done" });
    expect(calls[1]).toMatchObject({ name: "ue_mcp" });
    expect(JSON.stringify(s)).not.toContain("subagent chatter");
    expect(importTranscript(home, proj, "../../etc")).toBeNull();
  });

  it("counts a session as open elsewhere only when something else wrote it after Studio", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const saved = "2026-10-12T11:59:00Z";
    expect(writtenElsewhere(Date.parse("2026-10-12T11:59:05Z"), saved)).toBe(false);
    expect(writtenElsewhere(Date.parse("2026-10-12T11:59:50Z"), saved)).toBe(true);
    expect(activeElsewhere(now - 5_000, saved, now)).toBe(true);
    expect(activeElsewhere(now - 5_000, "2026-10-12T11:59:58Z", now)).toBe(false);
    expect(activeElsewhere(null, saved, now)).toBe(false);
  });

  it("moves Studio's old home over once, keeping the shared sign-in", () => {
    const old = tmp();
    const home = tmp();
    const proj = path.join(tmp(), "Vale");
    project(old, proj);
    fs.writeFileSync(path.join(old, ".credentials.json"), "old");
    fs.writeFileSync(path.join(home, ".credentials.json"), "shared");
    migrateHome(old, home);
    expect(fs.existsSync(path.join(transcriptsDir(home, proj), `${ID}.jsonl`))).toBe(true);
    expect(fs.readFileSync(path.join(home, ".credentials.json"), "utf-8")).toBe("shared");
    fs.rmSync(path.join(transcriptsDir(home, proj), `${ID}.jsonl`));
    migrateHome(old, home);
    expect(fs.existsSync(path.join(transcriptsDir(home, proj), `${ID}.jsonl`))).toBe(false);
  });

  it("brings the sign-in over when the shared home has none", () => {
    const old = tmp();
    const home = tmp();
    fs.writeFileSync(path.join(old, ".credentials.json"), "old");
    migrateHome(old, home);
    expect(fs.readFileSync(path.join(home, ".credentials.json"), "utf-8")).toBe("old");
  });
});
