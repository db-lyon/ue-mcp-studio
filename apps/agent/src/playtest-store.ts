/**
 * What Studio keeps about this project's playtests that ue-mcp's scripts do
 * not hold: who may start a run (the Playtest runs setting, manual or
 * automatic) and the player each step is for. One file in the extension's
 * per-project data directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { qaScriptKey, type PlaytestRunsMode } from "@ue-mcp-studio/shared";

interface Saved {
  runs?: PlaytestRunsMode;
  players?: Record<string, Record<string, string>>;
}

export class PlaytestStore {
  private readonly file: string;
  private data: Saved;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "playtests.json");
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Saved;
    } catch {
      this.data = {};
    }
  }

  /** Playtest runs: manual unless the user chose automatic. */
  runs(): PlaytestRunsMode {
    return this.data.runs === "automatic" ? "automatic" : "manual";
  }

  setRuns(mode: PlaytestRunsMode): void {
    this.data.runs = mode;
    this.write();
  }

  /** The player each step of a script is for, by step index. */
  players(script: string): Record<number, string> {
    const p = this.data.players?.[qaScriptKey(script)] ?? {};
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [Number(k), v]));
  }

  setPlayers(script: string, players: Record<number, string>): void {
    const key = qaScriptKey(script);
    const all = { ...(this.data.players ?? {}) };
    if (Object.keys(players).length === 0) delete all[key];
    else all[key] = Object.fromEntries(Object.entries(players).map(([k, v]) => [String(k), v]));
    this.data.players = all;
    this.write();
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
