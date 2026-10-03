/**
 * worker/client.ts — main-thread AnalysisClient.
 *
 *  - Spawns the analysis Worker (or a caller-injected one) and matches
 *    responses to requests by id.
 *  - LRU cache keyed by (glyphId, axes, params) so a glyph/axis is analyzed
 *    once. Analysis is static, so cache hits are always valid.
 *  - Synchronous INLINE FALLBACK (calls analyzeGlyph directly) when no Worker
 *    is available — SSR, tests, or environments without Worker support.
 *  - RUNTIME FALLBACK: if spawning throws, or the worker fires `error` /
 *    `messageerror` (e.g. its script 404s or fails to load under a consumer's
 *    bundler), the worker is marked dead + terminated and every pending and
 *    future request is served inline on the main thread. `mode` / `reason`
 *    expose this so the engine can surface it in `instance.notes`.
 *  - Never touches the DOM and never forces layout.
 */
import type { AnalyzeRequest, AnalyzeResponse, AnalyzeParams, Axis, PathCommand } from '../core/types.ts';
import { DEFAULT_PARAMS } from '../core/types.ts';
import { analyzeGlyph } from './analyze.ts';
import { spawnAnalysisWorker } from './spawn-analysis-worker.ts';
import { describeWorkerError } from './worker-error.ts';
import type { ClientMode } from './worker-error.ts';

export type { ClientMode } from './worker-error.ts';

export interface AnalysisClientOptions {
  /** Provide a Worker instance factory; omit to use the inline fallback. */
  workerFactory?: () => Worker;
  /** Force the synchronous inline path even if a Worker exists. */
  inline?: boolean;
  /** Max cached glyph/axis analyses (LRU). Default 512. */
  cacheSize?: number;
  /** Called once if the client degrades to the main thread (with the reason). */
  onFallback?: (reason: string) => void;
}

export interface AnalyzeGlyphInput {
  glyphId: string;
  commands: PathCommand[];
  advanceWidth: number;
  axes: Axis[];
  params?: Partial<AnalyzeParams>;
}

interface Pending {
  req: AnalyzeRequest;
  resolve: (r: AnalyzeResponse) => void;
  reject: (e: unknown) => void;
}

function paramsKey(p: AnalyzeParams): string {
  return `${p.slices}:${p.k}:${p.interiorSamples}:${p.smooth}:${p.samplesPerSegment}`;
}

export class AnalysisClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, AnalyzeResponse>();
  private readonly cacheSize: number;
  private nextId = 1;
  private inline: boolean;
  private _reason: string | undefined;
  private readonly opts: AnalysisClientOptions;

  constructor(opts: AnalysisClientOptions = {}) {
    this.opts = opts;
    this.cacheSize = opts.cacheSize ?? 512;
    const canSpawn = !!opts.workerFactory || (typeof Worker !== 'undefined' && !opts.inline);
    this.inline = !canSpawn || !!opts.inline;
    // An explicit `inline: true` is a choice, not a degradation → no reason.
    if (this.inline && !opts.inline) this._reason = 'Worker is not available in this environment';
  }

  /** 'worker' while analysis runs (or will run) off-thread; 'inline' once on the main thread. */
  get mode(): ClientMode {
    return this.inline ? 'inline' : 'worker';
  }

  /** Why the client is running inline (undefined when inline was requested or a worker is in use). */
  get reason(): string | undefined {
    return this._reason;
  }

  /** Mark the worker dead, terminate it, and serve all pending requests inline. */
  private fallBack(reason: string): void {
    if (this.inline) return;
    this.inline = true;
    this._reason = reason;
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      try {
        p.resolve(analyzeGlyph(p.req));
      } catch (err) {
        p.reject(err);
      }
    }
    try {
      this.opts.onFallback?.(reason);
    } catch {
      /* a throwing listener must not break analysis */
    }
  }

  private ensureWorker(): Worker | null {
    if (this.inline) return null;
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = this.opts.workerFactory ? this.opts.workerFactory() : spawnAnalysisWorker();
    } catch (err) {
      // Worker construction failed → permanently fall back to inline.
      this.fallBack(`worker spawn failed: ${describeWorkerError(err)}`);
      return null;
    }
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent) => {
      const res = ev.data as AnalyzeResponse;
      const p = this.pending.get(res.id);
      if (p) {
        this.pending.delete(res.id);
        p.resolve(res);
      }
    };
    worker.onerror = (err: unknown) => {
      // Handled: we recover on the main thread, so keep it off the console.
      (err as { preventDefault?: () => void } | null)?.preventDefault?.();
      this.fallBack(`worker error: ${describeWorkerError(err)}`);
    };
    worker.onmessageerror = (err: unknown) => {
      this.fallBack(`worker messageerror: ${describeWorkerError(err)}`);
    };
    return worker;
  }

  private cacheGet(key: string): AnalyzeResponse | undefined {
    const v = this.cache.get(key);
    if (v) {
      this.cache.delete(key);
      this.cache.set(key, v); // move to MRU
    }
    return v;
  }

  private cacheSet(key: string, v: AnalyzeResponse): void {
    this.cache.set(key, v);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Analyze one glyph for the requested axes (cached, off-thread when possible). */
  analyze(input: AnalyzeGlyphInput): Promise<AnalyzeResponse> {
    const params: AnalyzeParams = { ...DEFAULT_PARAMS, ...input.params };
    const axes = [...input.axes].sort();
    const key = `${input.glyphId}|${axes.join(',')}|${paramsKey(params)}`;

    const cached = this.cacheGet(key);
    if (cached) return Promise.resolve(cached);

    const id = this.nextId++;
    const req: AnalyzeRequest = {
      id,
      glyphId: input.glyphId,
      commands: input.commands,
      axes,
      params,
      advanceWidth: input.advanceWidth,
    };

    const worker = this.ensureWorker();
    if (!worker) {
      // Inline synchronous fallback.
      const res = analyzeGlyph(req);
      this.cacheSet(key, res);
      return Promise.resolve(res);
    }

    return new Promise<AnalyzeResponse>((resolve, reject) => {
      this.pending.set(id, {
        req,
        resolve: (r) => {
          this.cacheSet(key, r);
          resolve(r);
        },
        reject,
      });
      try {
        worker.postMessage(req);
      } catch (err) {
        // Could not hand the request to the worker → serve it (and the rest) inline.
        this.fallBack(`worker postMessage failed: ${describeWorkerError(err)}`);
      }
    });
  }

  /** Number of cached analyses (for diagnostics/tests). */
  get cacheCount(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
    this.cache.clear();
  }
}
