/**
 * The open session's detail, kept in step with the daemon by asking only for
 * what changed (see the agent's session-delta). One request at a time: asks
 * that arrive while one runs fold into a single follow-up for the latest
 * session, so a busy turn never queues a refetch per event. A loader made with
 * `tail` holds only the newest entries at first and reads older ones a page at
 * a time on `older`.
 */
import type { SessionDetail, SessionSync } from "@ue-mcp-studio/shared";

/** The held transcript's offset: the index of its first entry in the session's transcript. */
const fromOf = (d: SessionDetail | null): number => d?.from ?? 0;

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
        const detail = mergeSync(this.held?.id === id ? this.held.detail : null, sync, true);
        if (!detail) {
          // Cut back past the held page (a rewind): read the newest page again.
          this.held = null;
          this.wanted ??= id;
          continue;
        }
        this.held = { id, hashes: "hashes" in sync ? sync.hashes : undefined, detail };
        this.apply(detail);
      } catch (e) {
        if (this.held?.id === id) this.held = null;
        this.fail(e instanceof Error ? e : new Error(String(e)));
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
      const detail: SessionDetail = from ? { ...held.detail, transcript, from } : { ...held.detail, transcript };
      if (!from) delete detail.from;
      this.held = { ...held, detail };
      this.apply(detail);
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
