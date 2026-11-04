/**
 * The open session's detail, kept in step with the daemon by asking only for
 * what changed (see the agent's session-delta). One request at a time: asks
 * that arrive while one runs fold into a single follow-up for the latest
 * session, so a busy turn never queues a refetch per event.
 */
import type { SessionDetail, SessionSync } from "@ue-mcp-studio/shared";

/** The detail a sync answer leaves: the whole transcript, or the one held with the changed entries put in. */
export function mergeSync(prev: SessionDetail | null, sync: SessionSync | SessionDetail): SessionDetail {
  if (!("hashes" in sync)) return sync;
  const { hashes: _hashes, changed, transcript, ...rest } = sync;
  if (transcript) return { ...rest, transcript };
  const held = prev && prev.id === sync.id ? prev.transcript : [];
  const next = held.slice(0, changed?.length ?? held.length);
  for (const [i, e] of changed?.entries ?? []) next[i] = e;
  return { ...rest, transcript: next };
}

export type FetchSync = (id: string, have: string | undefined) => Promise<SessionSync | SessionDetail>;

export class DetailLoader {
  private held: { id: string; hashes: string | undefined; detail: SessionDetail } | null = null;
  private running: Promise<void> | null = null;
  private wanted: string | null = null;

  constructor(
    private readonly fetchSync: FetchSync,
    private readonly apply: (d: SessionDetail) => void,
    private readonly fail: (e: Error) => void,
  ) {}

  /** Ask for `id`; resolves once the latest asked session is in hand. */
  load(id: string): Promise<void> {
    this.wanted = id;
    if (!this.running) this.running = this.pump().finally(() => (this.running = null));
    return this.running;
  }

  /** Forget what is held, so the next load fetches the session whole. */
  reset(): void {
    this.held = null;
  }

  private async pump(): Promise<void> {
    while (this.wanted !== null) {
      const id = this.wanted;
      this.wanted = null;
      const have = this.held?.id === id ? this.held.hashes : undefined;
      try {
        const sync = await this.fetchSync(id, have);
        // A different session asked for meanwhile: this answer is not shown, the loop fetches that one.
        if (this.wanted !== null && this.wanted !== id) continue;
        const detail = mergeSync(this.held?.id === id ? this.held.detail : null, sync);
        this.held = { id, hashes: "hashes" in sync ? sync.hashes : undefined, detail };
        this.apply(detail);
      } catch (e) {
        if (this.held?.id === id) this.held = null;
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
}
