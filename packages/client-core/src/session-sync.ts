/**
 * The open session's detail, kept in step with the daemon by asking only for
 * what changed (see the agent's session-delta). One request at a time: asks
 * that arrive while one runs fold into a single follow-up for the latest
 * session, so a busy turn never queues a refetch per event. A loader made with
 * `tail` holds only the newest entries at first and reads older ones a page at
 * a time on `older`.
 */
import type { AgentThreadPage, SessionDetail, SessionSync, TranscriptEntry } from "@ue-mcp-studio/shared";

/** The held transcript's offset: the index of its first entry in the session's transcript. */
const fromOf = (d: SessionDetail | null): number => d?.from ?? 0;

/**
 * The fewest main-thread entries (no `parent`) a paged loader holds before it
 * stops reading older pages on its own. The chat draws only the main thread,
 * and while background subagents run, the newest page can be all theirs: a
 * daemon before 0.1.35-beta.28 answers such a page as asked, and the chat
 * would be empty with nothing to scroll that reads more.
 */
export const MIN_MAIN_ENTRIES = 20;

/** In place of an entry this client cannot read, so the rest of the chat still draws. */
export const UNREADABLE_ENTRY = "An entry here could not be read by this version of Studio.";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What an entry of each kind must carry for the chat models to read it; a kind not listed is drawn by its own fallback. */
const ENTRY_NEEDS: Record<string, (e: Record<string, unknown>) => boolean> = {
  user: (e) => typeof e.text === "string",
  assistant: (e) => typeof e.text === "string",
  note: (e) => typeof e.text === "string",
  tool: (e) => isObj(e.call) && typeof e.call.id === "string" && typeof e.call.name === "string",
  dialog: (e) => isObj(e.dialog),
  qa: (e) => isObj(e.run),
  review: (e) => isObj(e.review),
  flow: (e) => Array.isArray(e.steps),
  playtest: (e) => isObj(e.request),
};

/**
 * The detail with every part the chat reads in a shape it can read: a list
 * that is not one is empty, a derived part of the wrong type is left out (so
 * the client works it out from the transcript, as for an older daemon), and
 * an entry it cannot read becomes a note at the same place, so positions and
 * deltas still line up. `problems` says what was mended, for diagnostics.
 * One unexpected field never empties the chat.
 */
export function readableDetail(d: SessionDetail): { detail: SessionDetail; problems: string[] } {
  const problems: string[] = [];
  const raw = d as unknown as Record<string, unknown>;
  const changes = new Map<string, unknown>();
  const set = (k: string, v: unknown, why: string): void => {
    changes.set(k, v);
    problems.push(why);
  };
  const transcript = raw.transcript;
  if (!Array.isArray(transcript)) set("transcript", [], "transcript is not a list");
  else {
    let mended: unknown[] | null = null;
    for (let i = 0; i < transcript.length; i++) {
      const e: unknown = transcript[i];
      if (isObj(e) && typeof e.kind === "string" && (ENTRY_NEEDS[e.kind]?.(e) ?? true)) continue;
      mended ??= [...transcript];
      const parent = isObj(e) && typeof e.parent === "string" ? { parent: e.parent } : {};
      const at = isObj(e) && typeof e.at === "string" ? e.at : new Date(0).toISOString();
      mended[i] = { kind: "note", text: UNREADABLE_ENTRY, at, ...parent };
      problems.push(`entry ${(d.from ?? 0) + i} (${isObj(e) ? String(e.kind) : typeof e}) could not be read`);
    }
    if (mended) changes.set("transcript", mended);
  }
  for (const k of ["touched", "seen", "dismissed", "queue", "approvals", "timeline"]) if (k in raw && raw[k] != null && !Array.isArray(raw[k])) set(k, [], `${k} is not a list`);
  for (const k of ["subagents", "liveRuns"]) if (k in raw && raw[k] != null && !Array.isArray(raw[k])) set(k, undefined, `${k} is not a list`);
  if ("working" in raw && raw.working != null && !isObj(raw.working)) set("working", undefined, "working is not an object");
  if ("compacting" in raw && raw.compacting != null && typeof raw.compacting !== "boolean") set("compacting", undefined, "compacting is not true or false");
  if ("draft" in raw && typeof raw.draft !== "string") set("draft", "", "draft is not text");
  if (changes.size === 0) return { detail: d, problems };
  const out: Record<string, unknown> = { ...raw };
  for (const [k, v] of changes) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return { detail: out as unknown as SessionDetail, problems };
}

/** The control at the top of a paged chat that reads the entries before the held ones, for a thread too short to scroll. */
export const EARLIER_ENTRIES = "Show earlier messages";

/** How many main-thread entries the held transcript has. */
export const mainEntries = (transcript: readonly TranscriptEntry[]): number => transcript.reduce((n, e) => (e.parent ? n : n + 1), 0);

/** Whether a paged detail should read the page before it on its own: older entries left, and too few of the main thread to draw. */
export const wantsOlder = (d: SessionDetail, min = MIN_MAIN_ENTRIES): boolean => fromOf(d) > 0 && mainEntries(d.transcript) < min;

/**
 * The detail a sync answer leaves: the whole transcript, a page of it, or the
 * one held with the changed entries put in. Null when the answer cut the
 * transcript back past the start of a held page, so the newest page must be
 * read again.
 */
export function mergeSync(prev: SessionDetail | null, sync: SessionSync | SessionDetail): SessionDetail;
export function mergeSync(prev: SessionDetail | null, sync: SessionSync | SessionDetail, paged: true): SessionDetail | null;
export function mergeSync(prev: SessionDetail | null, sync: SessionSync | SessionDetail, _paged?: true): SessionDetail | null {
  if (!("hashes" in sync)) return sync;
  const { hashes: _hashes, changed, transcript, total: _total, from, ...rest } = sync;
  if (transcript) return from ? { ...rest, transcript, from } : { ...rest, transcript };
  const mine = prev && prev.id === sync.id ? prev : null;
  const start = fromOf(mine);
  const length = changed?.length ?? start + (mine?.transcript.length ?? 0);
  if (length < start) return null;
  const held = mine ? mine.transcript : [];
  const next = held.slice(0, length - start);
  for (const [i, e] of changed?.entries ?? []) if (i >= start) next[i - start] = e;
  return start ? { ...rest, transcript: next, from: start } : { ...rest, transcript: next };
}

export interface SyncPage {
  tail?: number;
  before?: number;
}

export type FetchSync = (id: string, have: string | undefined, page?: SyncPage) => Promise<SessionSync | SessionDetail>;

export interface DetailLoaderOptions {
  /** Hold only this many of the newest entries at first; older ones come a page of this size at a time. */
  tail?: number;
  /**
   * The session is gone (deleted here or elsewhere). Called instead of the
   * failure, because a deleted session is not an error to show: a refresh an
   * event asked for can land just after the delete.
   */
  gone?: (id: string) => void;
  /** Parts of an answer this client could not read and mended (readableDetail), for diagnostics. */
  problem?: (id: string, problems: string[]) => void;
}

/** The daemon answered that the session does not exist: 404 with "no session <id>". */
export function sessionGone(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 404 && e instanceof Error && /^no session\b/.test(e.message);
}

export class DetailLoader {
  private held: { id: string; hashes: string | undefined; detail: SessionDetail } | null = null;
  private running: Promise<void> | null = null;
  private wanted: string | null = null;
  private wantOlder: string | null = null;

  constructor(
    private readonly fetchSync: FetchSync,
    private readonly apply: (d: SessionDetail) => void,
    private readonly fail: (e: Error) => void,
    private readonly options: DetailLoaderOptions = {},
  ) {}

  /** Ask for `id`; resolves once the latest asked session is in hand. */
  load(id: string): Promise<void> {
    this.wanted = id;
    return this.run();
  }

  /** Read the page of entries before the held ones, if any are left; resolves once it is in. */
  older(id: string): Promise<void> {
    if (this.held?.id !== id || fromOf(this.held.detail) === 0) return Promise.resolve();
    this.wantOlder = id;
    return this.run();
  }

  /** Whether entries before the held ones are still to read. */
  hasOlder(id: string): boolean {
    return this.held?.id === id && fromOf(this.held.detail) > 0;
  }

  /** Forget what is held, so the next load fetches the session whole. */
  reset(): void {
    this.held = null;
  }

  private run(): Promise<void> {
    if (!this.running) this.running = this.pump().finally(() => (this.running = null));
    return this.running;
  }

  /** The detail in a shape the chat reads, what was mended reported. */
  private readable(id: string, d: SessionDetail): SessionDetail {
    const { detail, problems } = readableDetail(d);
    if (problems.length) this.options.problem?.(id, problems);
    return detail;
  }

  private async pump(): Promise<void> {
    while (this.wanted !== null || this.wantOlder !== null) {
      if (this.wanted === null) {
        const id = this.wantOlder!;
        this.wantOlder = null;
        await this.page(id);
        continue;
      }
      const id = this.wanted;
      this.wanted = null;
      const have = this.held?.id === id ? this.held.hashes : undefined;
      const tail = this.options.tail;
      try {
        const sync = await this.fetchSync(id, have, have === undefined && tail ? { tail } : undefined);
        // A different session asked for meanwhile: this answer is not shown, the loop fetches that one.
        if (this.wanted !== null && this.wanted !== id) continue;
        const merged = mergeSync(this.held?.id === id ? this.held.detail : null, sync, true);
        const detail = merged && this.readable(id, merged);
        if (!detail) {
          // Cut back past the held page (a rewind): read the newest page again.
          this.held = null;
          this.wanted ??= id;
          continue;
        }
        this.held = { id, hashes: "hashes" in sync ? sync.hashes : undefined, detail };
        this.apply(detail);
        // A page with too little of the main thread to draw reads the one before it.
        if (tail && wantsOlder(detail, Math.min(tail, MIN_MAIN_ENTRIES))) this.wantOlder ??= id;
      } catch (e) {
        if (this.held?.id === id) this.held = null;
        if (sessionGone(e) && this.options.gone) this.options.gone(id);
        else this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** The page before the held entries, put in front of them. The held hashes stay: a page is read as it is now. */
  private async page(id: string): Promise<void> {
    const held = this.held;
    const before = fromOf(held?.detail ?? null);
    if (!held || held.id !== id || before === 0) return;
    try {
      const sync = await this.fetchSync(id, undefined, { tail: this.options.tail ?? before, before });
      // The session changed or was read whole meanwhile: this page no longer fits.
      if (this.held !== held || !("hashes" in sync) || !sync.transcript) return;
      const from = sync.from ?? 0;
      const transcript = [...sync.transcript.slice(0, before - from), ...held.detail.transcript];
      const detail: SessionDetail = this.readable(id, from ? { ...held.detail, transcript, from } : { ...held.detail, transcript });
      if (!from) delete detail.from;
      this.held = { ...held, detail };
      this.apply(detail);
      // Still too little of the main thread, and this page got further back: the one before it too.
      const tail = this.options.tail;
      if (tail && from < before && wantsOlder(detail, Math.min(tail, MIN_MAIN_ENTRIES))) this.wantOlder ??= id;
    } catch (e) {
      if (sessionGone(e) && this.options.gone) this.options.gone(id);
      else this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** How many of a subagent's newest entries a thread reads at first, and per page after. */
export const THREAD_PAGE = 200;

/** A subagent's thread as held: its entries from `from` to its end, of `total`. */
export interface HeldThread {
  sessionId: string;
  callId: string;
  entries: TranscriptEntry[];
  from: number;
  total: number;
}

export type FetchThread = (sessionId: string, callId: string, page: { tail?: number; before?: number }) => Promise<AgentThreadPage>;

/**
 * A subagent's thread, read by its id (GET .../agents/:callId) whatever part
 * of the main transcript the client holds: its newest page first, the pages
 * before it on `older`. `load` again (an event changed the session) reads
 * the held span again from where it starts, so a step that finished or a new
 * line comes in. One request at a time, as DetailLoader.
 */
export class ThreadLoader {
  private held: HeldThread | null = null;
  private running: Promise<void> | null = null;
  private wanted: { sessionId: string; callId: string } | null = null;
  private wantOlder = false;

  constructor(
    private readonly fetchThread: FetchThread,
    private readonly apply: (t: HeldThread | null) => void,
    private readonly fail: (e: Error) => void,
    private readonly page = THREAD_PAGE,
  ) {}

  /** Read (or read again) the thread of `callId`. */
  load(sessionId: string, callId: string): Promise<void> {
    this.wanted = { sessionId, callId };
    return this.run();
  }

  /** Read the page before the held entries, if any are left. */
  older(): Promise<void> {
    if (!this.held || this.held.from === 0) return Promise.resolve();
    this.wantOlder = true;
    return this.run();
  }

  hasOlder(): boolean {
    return !!this.held && this.held.from > 0;
  }

  /** Forget the held thread (it was closed). */
  reset(): void {
    this.held = null;
    this.wanted = null;
    this.wantOlder = false;
  }

  private run(): Promise<void> {
    if (!this.running) this.running = this.pump().finally(() => (this.running = null));
    return this.running;
  }

  private async pump(): Promise<void> {
    while (this.wanted || this.wantOlder) {
      try {
        if (this.wanted) {
          const { sessionId, callId } = this.wanted;
          this.wanted = null;
          const mine = this.held && this.held.sessionId === sessionId && this.held.callId === callId ? this.held : null;
          // The held span again with room for what came since (a page more), or the newest page.
          const p = await this.fetchThread(sessionId, callId, { tail: mine ? mine.total - mine.from + this.page : this.page });
          // Another thread asked for meanwhile: this answer is not shown, the loop reads that one.
          const next = this.wanted as { sessionId: string; callId: string } | null;
          if (next && (next.sessionId !== sessionId || next.callId !== callId)) continue;
          this.held = { sessionId, callId, entries: p.entries, from: p.from, total: p.total };
          this.apply(this.held);
        } else {
          this.wantOlder = false;
          const held = this.held;
          if (!held || held.from === 0) continue;
          const p = await this.fetchThread(held.sessionId, held.callId, { tail: this.page, before: held.from });
          if (this.held !== held) continue;
          this.held = { ...held, entries: [...p.entries, ...held.entries], from: p.from };
          this.apply(this.held);
        }
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
}
