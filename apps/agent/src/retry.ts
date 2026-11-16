/**
 * A model request that a passing fault does not end: a dropped connection,
 * 408, 409, 425, 429, a 5xx or 529 (overloaded) is sent again after a wait,
 * up to four tries in all, honouring the answer's retry-after. Only the last
 * answer, good or bad, reaches the caller, so a turn ends on a fault only
 * when it outlasts every try. A stopped turn (the signal) is never retried.
 */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
export const RETRY_TRIES = 4;
/** The longest wait between tries, whatever retry-after asks. */
const MAX_WAIT_MS = 30_000;

export const retryable = (status: number): boolean => RETRY_STATUS.has(status);

/** How long to wait before try `n` (1-based, after the first): retry-after when given, else 1, 2, 4 s. */
export function retryWait(n: number, retryAfter: string | null, now = Date.now()): number {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_WAIT_MS);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), MAX_WAIT_MS);
  }
  return Math.min(1000 * 2 ** (n - 1), MAX_WAIT_MS);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** fetch, tried again on a passing fault. `init.body` must be resendable (a string). */
export async function fetchRetrying(fetchImpl: typeof fetch, url: string, init: RequestInit, o: { tries?: number; wait?: (ms: number, signal?: AbortSignal | null) => Promise<void> } = {}): Promise<Response> {
  const tries = o.tries ?? RETRY_TRIES;
  const wait = o.wait ?? sleep;
  for (let n = 1; ; n++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      if (init.signal?.aborted || n >= tries) throw e;
      await wait(retryWait(n, null), init.signal);
      continue;
    }
    if (res.ok || !retryable(res.status) || n >= tries) return res;
    // Read the refused body so the connection is freed before the next try.
    await res.text().catch(() => "");
    await wait(retryWait(n, res.headers.get("retry-after")), init.signal);
  }
}
