/**
 * gating.ts — IntersectionObserver visibility gate (R5).
 *
 * Offscreen instances must go fully idle: the controller uses this to suspend
 * its ticker subscriptions + stimulus listeners while out of view and resume on
 * re-entry. When IntersectionObserver is unavailable (Node/SSR) the element is
 * treated as always visible, so consumers work headless with no gating.
 */

export interface IntersectionEntryLike {
  isIntersecting: boolean;
}

export interface IntersectionObserverLike {
  observe(target: unknown): void;
  unobserve(target: unknown): void;
  disconnect(): void;
}

export interface VisibilityOptions {
  /** Injectable observer factory (default: global IntersectionObserver). */
  factory?: (cb: (entries: IntersectionEntryLike[]) => void) => IntersectionObserverLike;
  threshold?: number | number[];
  root?: unknown;
  rootMargin?: string;
}

/**
 * Observe `el`'s viewport visibility. `cb(visible)` fires on every change (and
 * once synchronously with `true` if no observer is available). Returns a
 * teardown fn.
 */
export function observeVisibility(
  el: unknown,
  cb: (visible: boolean) => void,
  opts: VisibilityOptions = {},
): () => void {
  const handler = (entries: IntersectionEntryLike[]): void => {
    for (const e of entries) cb(e.isIntersecting);
  };

  if (opts.factory) {
    const io = opts.factory(handler);
    io.observe(el);
    return () => io.disconnect();
  }

  if (typeof IntersectionObserver === 'undefined') {
    cb(true); // headless: assume visible so work still runs
    return () => {};
  }

  const io = new IntersectionObserver(
    (entries) => handler(entries as unknown as IntersectionEntryLike[]),
    { threshold: opts.threshold ?? 0, root: (opts.root ?? null) as Element | null, rootMargin: opts.rootMargin ?? '0px' },
  );
  io.observe(el as Element);
  return () => io.disconnect();
}
