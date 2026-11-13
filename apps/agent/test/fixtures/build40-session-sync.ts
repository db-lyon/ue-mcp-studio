/**
 * The session loader of Android build 40 (Studio 0.1.35-beta.25), frozen as it
 * shipped in packages/client-core/src/session-sync.ts at 3c5704f. Installed
 * phones keep running this code against newer daemons, so the daemon's
 * answers are tested against it. Never update it to match the current client.
 */
import type { SessionDetail, SessionSync } from "@ue-mcp-studio/shared";

const fromOf = (d: SessionDetail | null): number => d?.from ?? 0;

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

export class DetailLoader {
  private held: { id: string; hashes: string | undefined; detail: SessionDetail } | null = null;
  private running: Promise<void> | null = null;
  private wanted: string | null = null;
  private wantOlder: string | null = null;

  constructor(
    private readonly fetchSync: FetchSync,
    private readonly apply: (d: SessionDetail) => void,
    private readonly fail: (e: Error) => void,
    private readonly options: { tail?: number } = {},
  ) {}

  load(id: string): Promise<void> {
    this.wanted = id;
    return this.run();
  }

  older(id: string): Promise<void> {
    if (this.held?.id !== id || fromOf(this.held.detail) === 0) return Promise.resolve();
    this.wantOlder = id;
    return this.run();
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
        if (this.wanted !== null && this.wanted !== id) continue;
        const detail = mergeSync(this.held?.id === id ? this.held.detail : null, sync, true);
        if (!detail) {
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

  private async page(id: string): Promise<void> {
    const held = this.held;
    const before = fromOf(held?.detail ?? null);
    if (!held || held.id !== id || before === 0) return;
    try {
      const sync = await this.fetchSync(id, undefined, { tail: this.options.tail ?? before, before });
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
