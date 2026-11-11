/**
 * The UE-MCP app's host, UE-MCP.exe, as the page reaches it: window.ue.app,
 * each call a Promise answered over postMessage (apps/window/src/app.cpp).
 * Visual QA installs a stand-in with the same calls.
 */

export interface HostState {
  mode: "app" | "setup";
  version: string;
  node: { found: boolean; version: string; ok: boolean; min: number };
  winget: boolean;
  channel: "latest" | "beta";
  installDir: string;
  installed: { version: string; dir: string } | null;
  /** This exe against the installed one. */
  compare?: "newer" | "same" | "older";
}

export interface ReportAnswer {
  ok: boolean;
  /** The machine report's JSON. */
  report?: string;
  /** node: no Node.js; unsupported: the ue-mcp found has no `projects`; version: a report this app cannot read; failed: the command failed. */
  reason?: "node" | "unsupported" | "version" | "failed";
  error?: string;
  /** The ue-mcp package spec the host ran. */
  ueMcp?: string;
  /** The last good report, when this read failed. */
  cached?: string;
  cachedAt?: string;
}

export interface JobState {
  running: boolean;
  ok: boolean;
  lines?: string[];
  error?: string;
}

export interface Done {
  ok: boolean;
  error?: string;
  job?: number;
  cancelled?: boolean;
}

export interface DaemonAnswer {
  status?: number;
  body?: string;
  error?: string;
}

export interface Live {
  pid: number;
  port: number;
  version: string;
}

/** Studio's release channel, one choice for the machine: the app updates from it and runs ue-mcp's matching npm tag. */
export type Channel = "stable" | "beta";

export interface AppUpdate {
  ok: boolean;
  /** The channel the check read. */
  channel?: Channel;
  version?: string;
  newer?: boolean;
  started?: boolean;
  error?: string;
}

/**
 * The newest release of each part a project runs, on the channel, read by the
 * host without any daemon: ue-mcp from npm, Studio from latest.json, the
 * Studio editor plugin from its plugin.json. A part it could not read is
 * missing, with why under errors.
 */
export interface Newest {
  channel?: Channel;
  ueMcp?: string;
  studio?: string;
  plugin?: string;
  errors?: { ueMcp?: string; studio?: string; plugin?: string };
}

type Call = (arg?: unknown) => Promise<unknown>;

export interface AppHost {
  getstate(): Promise<HostState>;
  refreshnode(): Promise<HostState>;
  report(): Promise<ReportAnswer>;
  /** The last report read, as its JSON, or null. */
  cachedreport(): Promise<string | null>;
  job(id: number): Promise<JobState>;
  daemon(arg: { key: string; method: "GET" | "POST"; path: string; body?: string }): Promise<DaemonAnswer>;
  live(arg: { keys: string[] }): Promise<Record<string, Live>>;
  install(arg: { uproject: string }): Promise<Done>;
  startdaemon(arg: { uproject: string }): Promise<Done>;
  stopdaemon(arg: { uproject: string }): Promise<Done>;
  updatebridge(arg: { uproject: string; version: string }): Promise<Done>;
  installnode(arg: { consent: "yes" }): Promise<Done>;
  openstudio(arg: { key: string; uproject: string; location?: string }): Promise<Done>;
  launcheditor(arg: { key: string; uproject: string; setUp: boolean }): Promise<Done>;
  addproject(): Promise<Done>;
  removeproject(arg: { uproject: string }): Promise<Done>;
  readlog(arg: { key: string }): Promise<string>;
  openlog(arg: { key: string }): Promise<boolean>;
  openfolder(arg: { path: string }): Promise<boolean>;
  openurl(arg: { url: string }): Promise<boolean>;
  getchannel(): Promise<{ channel: Channel }>;
  setchannel(arg: { channel: Channel }): Promise<Done & { channel?: Channel }>;
  appupdate(arg?: { install?: "yes" }): Promise<AppUpdate>;
  newest(): Promise<Newest>;
  setup(): Promise<Done>;
  launch(): Promise<boolean>;
  close(): Promise<boolean>;
}

/** Where the host puts its calls: window.ue.app, beside Studio's window.ue.studio. */
export const appSlot = (): { ue?: { app?: Record<string, Call> } } => window as unknown as { ue?: { app?: Record<string, Call> } };

/** The host's calls, or null outside UE-MCP.exe. */
export function host(): AppHost | null {
  return (appSlot().ue?.app as unknown as AppHost | undefined) ?? null;
}

/** Poll a job until it ends, reporting each state. */
export async function follow(id: number, onState: (s: JobState) => void, everyMs = 700): Promise<JobState> {
  const h = host();
  if (!h) return { running: false, ok: false, error: "UE-MCP's host is not here." };
  for (;;) {
    const s = await h.job(id);
    onState(s);
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
