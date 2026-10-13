import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteTranscripts, projectKey, restoreTranscripts, transcriptsDir } from "../src/claude-sessions.js";

const ID = "2f01f625-aefc-4d24-80f3-5a941d67cac5";
const OTHER = "bee598ba-74d3-4e6d-a463-f1acd3ff679d";
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cs-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function write(home: string, proj: string, id: string, text: string, at: number) {
  const dir = transcriptsDir(home, proj);
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, at / 1000, at / 1000);
  return file;
}

describe("the Claude conversations behind Studio's sessions", () => {
  it("finds a project's folder the way Claude names it", () => {
    expect(projectKey("C:\\Users\\david\\Projects\\UE\\Vale")).toBe("C--Users-david-Projects-UE-Vale");
  });

  it("copies back, once, the conversations the betas left in Claude Code's home, newest copy winning", () => {
    const shared = tmp();
    const own = tmp();
    const proj = path.join(tmp(), "Vale");
    write(shared, proj, ID, "newer, from a beta turn", Date.parse("2026-10-12T20:00:00Z"));
    write(own, proj, ID, "older", Date.parse("2026-10-12T10:00:00Z"));
    write(shared, proj, OTHER, "only there", Date.parse("2026-10-12T19:00:00Z"));
    write(shared, proj, "11111111-1111-1111-1111-111111111111", "not Studio's", Date.parse("2026-10-12T19:00:00Z"));
    expect(restoreTranscripts([ID, OTHER, ""], shared, own, proj)).toBe(2);
    expect(fs.readFileSync(path.join(transcriptsDir(own, proj), `${ID}.jsonl`), "utf-8")).toBe("newer, from a beta turn");
    expect(fs.existsSync(path.join(transcriptsDir(own, proj), `${OTHER}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(transcriptsDir(own, proj), "11111111-1111-1111-1111-111111111111.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(transcriptsDir(shared, proj), `${ID}.jsonl`))).toBe(true);
    write(shared, proj, ID, "Claude Code's own later turn", Date.parse("2026-10-13T09:00:00Z"));
    expect(restoreTranscripts([ID], shared, own, proj)).toBe(0);
  });

  it("removes a deleted session's conversations, and only those", () => {
    const own = tmp();
    const proj = path.join(tmp(), "Vale");
    write(own, proj, ID, "x", Date.now());
    write(own, proj, OTHER, "y", Date.now());
    deleteTranscripts([ID, "../../escape"], own, proj);
    expect(fs.existsSync(path.join(transcriptsDir(own, proj), `${ID}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(transcriptsDir(own, proj), ID))).toBe(false);
    expect(fs.existsSync(path.join(transcriptsDir(own, proj), `${OTHER}.jsonl`))).toBe(true);
  });
});
