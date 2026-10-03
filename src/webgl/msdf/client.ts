/**
 * webgl/msdf/client.ts — main-thread MSDF generation client.
 *
 * Mirrors the analysis-core `AnalysisClient` (src/worker/client.ts): spawns the
 * MSDF worker (or a caller-injected one), matches responses by id, LRU-caches
 * generated bitmaps keyed by (glyphId, fontSize, pxRange, dpr), and falls back
 * to a synchronous INLINE call when no Worker is available (SSR / tests) — or at
 * RUNTIME when spawning throws or the worker fires `error`/`messageerror` (its
 * script failed to load): the worker is terminated and every pending + future
 * request is served inline on the main thread (`mode`/`reason` report it). MSDF
 * for a glyph at a raster size is static, so cache hits are always valid; a DPR
 * change changes the key, which drives the lazy re-raster (obligation 6).
 */
import type { PathCommand } from '../../core/types.ts';
import type { MSDFOptions, MSDFBitmap } from './generator.ts';
import type { MsdfRequest, MsdfResponse } from './worker.ts';
import { handleMsdfRequest } from './worker.ts';
import { spawnMsdfWorker } from './spawn-msdf-worker.ts';
import { describeWorkerError } from '../../worker/worker-error.ts';
import type { ClientMode } from '../../worker/worker-error.ts';

export interface MsdfClientOptions {
  workerFactory?: () => Worker;
  inline?: boolean;
  /** Max cached bitmaps (LRU). Default 512. */
  cacheSize?: number;
  /** Called once if the client degrades to the main thread (with the reason). */
  onFallback?: (reason: string) => void;
}

export interface MsdfGlyphInput {
  glyphId: string;
  commands: PathCommand[];
  options: MSDFOptions;
  /** Device pixel ratio (part of the cache key so DPR changes re-raster). */
  dpr?: number;
}

interface Pending {
  req: MsdfRequest;
  resolve: (b: MSDFBitmap) => void;
  reject: (e: unknown) => void;
}

function keyOf(input: MsdfGlyphInput): string {
  const o = input.options;
  return `${input.glyphId}|${o.fontSize}|${o.pxRange ?? 4}|${o.unitsPerEm ?? 1000}|${input.dpr ?? 1}`;
}

export class MsdfClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, MSDFBitmap>();
  private readonly cacheSize: number;
  private nextId = 1;
  private inline: boolean;
  private _reason: string | undefined;
  private readonly opts: MsdfClientOptions;

  constructor(opts: MsdfClientOptions = {}) {
    this.opts = opts;
    this.cacheSize = opts.cacheSize ?? 512;
    const canSpawn = !!opts.workerFactory || (typeof Worker !== 'undefined' && !opts.inline);
    this.inline = !canSpawn || !!opts.inline;
    if (this.inline && !opts.inline) this._reason = 'Worker is not available in this environment';
  }

  /** 'worker' while rasterization runs (or will run) off-thread; 'inline' once on the main thread. */
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
        p.resolve(handleMsdfRequest(p.req).bitmap);
      } catch (err) {
        p.reject(err);
      }
    }
    try {
      this.opts.onFallback?.(reason);
    } catch {
      /* a throwing listener must not break rasterization */
    }
  }

  private ensureWorker(): Worker | null {
    if (this.inline) return null;
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = this.opts.workerFactory ? this.opts.workerFactory() : spawnMsdfWorker();
    } catch (err) {
      this.fallBack(`worker spawn failed: ${describeWorkerError(err)}`);
      return null;
    }
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent) => {
      const res = ev.data as MsdfResponse;
      const p = this.pending.get(res.id);
      if (p) {
        this.pending.delete(res.id);
        p.resolve(res.bitmap);
      }
    };
    worker.onerror = (err: unknown) => {
      (err as { preventDefault?: () => void } | null)?.preventDefault?.();
      this.fallBack(`worker error: ${describeWorkerError(err)}`);
    };
    worker.onmessageerror = (err: unknown) => {
      this.fallBack(`worker messageerror: ${describeWorkerError(err)}`);
    };
    return worker;
  }

  private cacheGet(key: string): MSDFBitmap | undefined {
    const v = this.cache.get(key);
    if (v) {
      this.cache.delete(key);
      this.cache.set(key, v);
    }
    return v;
  }

  private cacheSet(key: string, v: MSDFBitmap): void {
    this.cache.set(key, v);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Synchronously return a cached bitmap, or undefined if not yet generated. */
  peek(input: MsdfGlyphInput): MSDFBitmap | undefined {
    return this.cache.get(keyOf(input));
  }

  /** Generate (or fetch cached) MSDF for a glyph at a raster size. */
  generate(input: MsdfGlyphInput): Promise<MSDFBitmap> {
    const key = keyOf(input);
    const cached = this.cacheGet(key);
    if (cached) return Promise.resolve(cached);

    const id = this.nextId++;
    const req: MsdfRequest = {
      id,
      glyphId: input.glyphId,
      commands: input.commands,
      options: input.options,
    };

    const worker = this.ensureWorker();
    if (!worker) {
      const res = handleMsdfRequest(req);
      this.cacheSet(key, res.bitmap);
      return Promise.resolve(res.bitmap);
    }

    return new Promise<MSDFBitmap>((resolve, reject) => {
      this.pending.set(id, {
        req,
        resolve: (b) => {
          this.cacheSet(key, b);
          resolve(b);
        },
        reject,
      });
      try {
        worker.postMessage(req);
      } catch (err) {
        this.fallBack(`worker postMessage failed: ${describeWorkerError(err)}`);
      }
    });
  }

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
