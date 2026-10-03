/**
 * worker/worker-error.ts — shared by the analysis + MSDF clients' main-thread
 * fallback: the client mode type and a readable reason from a worker failure.
 */

/** Where a client's work runs: off-thread in a Worker, or inline on the main thread. */
export type ClientMode = 'worker' | 'inline';

/** Best-effort human-readable reason from a worker error/messageerror event. */
export function describeWorkerError(err: unknown): string {
  const e = err as { message?: unknown; type?: unknown; filename?: unknown } | null;
  if (e && typeof e.message === 'string' && e.message) return e.message;
  if (e && typeof e.type === 'string' && e.type) {
    return `worker ${e.type} event${typeof e.filename === 'string' && e.filename ? ` (${e.filename})` : ''}`;
  }
  return String(err);
}
