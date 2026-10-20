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

  it("copies, once, the conversations Studio's own home kept into Claude Code's, newest copy winning", () => {
    const studio = tmp();
    const claude = tmp();
    const proj = path.join(tmp(), "Vale");
    write(studio, proj, ID, "newer, from a Studio turn", Date.parse("2026-10-12T20:00:00Z"));
    write(claude, proj, ID, "older", Date.parse("2026-10-12T10:00:00Z"));
    write(studio, proj, OTHER, "only there", Date.parse("2026-10-12T19:00:00Z"));
    write(studio, proj, "11111111-1111-1111-1111-111111111111", "not a session's", Date.parse("2026-10-12T19:00:00Z"));
    expect(restoreTranscripts([ID, OTHER, ""], studio, claude, proj)).toBe(2);
    expect(fs.readFileSync(path.join(transcriptsDir(claude, proj), `${ID}.jsonl`), "utf-8")).toBe("newer, from a Studio turn");
    expect(fs.existsSync(path.join(transcriptsDir(claude, proj), `${OTHER}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(transcriptsDir(claude, proj), "11111111-1111-1111-1111-111111111111.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(transcriptsDir(studio, proj), `${ID}.jsonl`))).toBe(true);
    // The once-only mark goes in the old home; Claude Code's gets only the conversations.
    expect(fs.readdirSync(transcriptsDir(claude, proj)).filter((f) => f.startsWith("."))).toEqual([]);
    write(studio, proj, ID, "a later copy", Date.parse("2026-10-13T09:00:00Z"));
    expect(restoreTranscripts([ID], studio, claude, proj)).toBe(0);
  });

  it("does nothing when the two homes are the same", () => {
    const home = tmp();
    const proj = path.join(tmp(), "Vale");
    write(home, proj, ID, "x", Date.now());
    expect(restoreTranscripts([ID], home, home, proj)).toBe(0);
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
