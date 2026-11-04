// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../rv-viewer';
import { RV_VERSION } from '../rv-version';
import { getActiveContexts } from '../hmi/ui-context-store';
import { getHmiVisible } from '../hmi/hmi-visibility-store';
import { getProblems } from '../hmi/problems-store';
import { fetchGatewayHealth, isServedByConnectOrigin } from '../hmi/connect-store';
import { redactUrl } from './rv-diagnostics-redact';
import {
  diagnosticsCollector, getDiagnosticsEntries, subscribeDiagnosticsEntries,
  type DiagEntry, type DiagTabState,
} from './rv-diagnostics-collector';

const MAX_BATCH_COUNT = 200;
const MAX_BATCH_BYTES = 200 * 1024;
const MAX_QUEUE = 5000;
const ONE_SECOND = 1000;
const encoder = new TextEncoder();

export interface DiagnosticsStreamerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  servedByConnect?: () => Promise<boolean>;
  sendDebug?: boolean;
}

let viewer: RVViewer | null = null;
let connectOrigin: boolean | null = null;

export async function isDiagnosticsConnectOrigin(): Promise<boolean> {
  if (connectOrigin !== null) return connectOrigin;
  if (typeof window === 'undefined') return false;
  if (isServedByConnectOrigin()) return (connectOrigin = true);
  try {
    await fetchGatewayHealth(window.location.origin);
    return (connectOrigin = true);
  } catch {
    return (connectOrigin = false);
  }
}

export function resetDiagnosticsConnectOriginForTests(value: boolean | null = null): void {
  connectOrigin = value;
}

function truncateEntry(entry: DiagEntry, hard = false): DiagEntry {
  const msgMax = hard ? 2000 : 8000;
  const stackMax = hard ? 4000 : 16000;
  return {
    ...entry,
    msg: entry.msg.slice(0, msgMax),
    ...(entry.stack ? { stack: entry.stack.slice(0, stackMax) } : {}),
  };
}

function bodyOf(entries: readonly DiagEntry[]): string {
  return JSON.stringify({ entries });
}

export function batchByUtf8(entries: readonly DiagEntry[], byteLimit = MAX_BATCH_BYTES): DiagEntry[] {
  const batch: DiagEntry[] = [];
  // Running size of `{"entries":[...]}`: the envelope plus each entry and its separating comma,
  // so every entry is encoded once instead of re-encoding the whole candidate body per step.
  let bytes = encoder.encode(bodyOf([])).byteLength;
  for (const raw of entries.slice(0, MAX_BATCH_COUNT)) {
    const entry = truncateEntry(raw);
    const entryBytes = encoder.encode(JSON.stringify(entry)).byteLength + (batch.length > 0 ? 1 : 0);
    if (bytes + entryBytes > byteLimit) break;
    bytes += entryBytes;
    batch.push(entry);
  }
  if (batch.length === 0 && entries.length > 0) batch.push(truncateEntry(entries[0], true));
  return batch;
}

export class DiagnosticsStreamer {
  private queue: DiagEntry[] = [];
  private started = false;
  private active = false;
  private sending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = ONE_SECOND;
  private lastRequestAt = 0;
  private batchCountLimit = MAX_BATCH_COUNT;
  private unsubscribe: (() => void) | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly servedByConnect: () => Promise<boolean>;
  private readonly sendDebug: boolean;

  constructor(options: DiagnosticsStreamerOptions = {}) {
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.servedByConnect = options.servedByConnect ?? isDiagnosticsConnectOrigin;
    // CONNECT's default server level is info. Debug is deliberately opt-in so routine
    // model detail does not consume disk/bandwidth; trace is never streamed.
    this.sendDebug = options.sendDebug ?? false;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = subscribeDiagnosticsEntries(entry => {
      this.enqueue(entry);
      if (entry.cat === 'react') this.enqueue(createTabStateEntry());
    });
    this.active = await this.servedByConnect();
    if (!this.active) return;
    for (const entry of getDiagnosticsEntries({ sinceMs: 15 * 60_000 })) this.enqueue(entry);
    this.enqueue(createTabStateEntry());
    this.schedule(0);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.started = false;
  }

  enqueue(entry: DiagEntry): void {
    if (entry.kind !== 'state' && (entry.lvl === 'trace' || (entry.lvl === 'debug' && !this.sendDebug))) return;
    const prepared = truncateEntry(entry);
    // State is time-sensitive (especially immediately before an export), so it
    // precedes an older log backlog while ordinary logs remain FIFO.
    if (entry.kind === 'state') this.queue.unshift(prepared);
    else this.queue.push(prepared);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.active) this.schedule(ONE_SECOND);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.active || this.sending || this.queue.length === 0) return;
    const wait = Math.max(0, ONE_SECOND - (this.now() - this.lastRequestAt));
    if (wait > 0) { this.schedule(wait); return; }
    this.sending = true;
    let batch = batchByUtf8(this.queue.slice(0, this.batchCountLimit));
    try {
      while (batch.length > 0) {
        this.lastRequestAt = this.now();
        // The queue may change while the request is in flight (a state snapshot is unshifted to
        // the front), so the sent entries are removed by identity, never by position.
        const sent = new Set(this.queue.slice(0, batch.length));
        const dropSent = () => { this.queue = this.queue.filter(e => !sent.has(e)); };
        const response = await this.fetchFn('/diag/client-log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyOf(batch),
        });
        if (response.ok) {
          dropSent();
          this.backoffMs = ONE_SECOND;
          this.batchCountLimit = MAX_BATCH_COUNT;
          break;
        }
        if (response.status === 413) {
          if (batch.length > 1) this.batchCountLimit = Math.max(1, Math.floor(batch.length / 2));
          else {
            const harder = truncateEntry(batch[0], true);
            const index = this.queue.findIndex(e => sent.has(e));
            if (index >= 0) {
              if (harder.msg === batch[0].msg && harder.stack === batch[0].stack) this.queue.splice(index, 1);
              else this.queue[index] = harder;
            }
          }
          this.schedule(ONE_SECOND);
          break;
        }
        if (response.status === 429 || response.status >= 500) this.retry();
        else dropSent();
        break;
      }
    } catch { this.retry(); }
    finally {
      this.sending = false;
      if (this.queue.length > 0 && this.timer === null) this.schedule(this.backoffMs);
    }
  }

  async flushAndWait(): Promise<void> {
    if (!this.active || this.queue.length === 0) return;
    const wait = Math.max(0, ONE_SECOND - (this.now() - this.lastRequestAt));
    if (wait > 0) await new Promise<void>(resolve => this.setTimer(resolve, wait));
    await this.flush();
  }

  flushBeacon(): boolean {
    if (!this.active || this.queue.length === 0 || typeof navigator.sendBeacon !== 'function') return false;
    const batch = batchByUtf8(this.queue, 60 * 1024);
    if (batch.length === 0) return false;
    const ok = navigator.sendBeacon('/diag/client-log', new Blob([bodyOf(batch)], { type: 'application/json' }));
    if (ok) this.queue.splice(0, batch.length);
    return ok;
  }

  getQueueForTests(): readonly DiagEntry[] { return this.queue; }
  clearQueueForTests(): void {
    this.queue = [];
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private retry(): void {
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.schedule(this.backoffMs);
  }

  private schedule(delay: number): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }
}

export const diagnosticsStreamer = new DiagnosticsStreamer();
let installPromise: Promise<void> | null = null;

export function installDiagnosticsStreamer(): Promise<void> {
  if (!installPromise) {
    installPromise = diagnosticsStreamer.start();
    window.addEventListener('pagehide', () => diagnosticsStreamer.flushBeacon());
    setInterval(() => queueTabStateSnapshot(), 60_000);
  }
  return installPromise;
}

export function attachDiagnosticsViewer(next: RVViewer): void {
  viewer = next;
  next.on('model-loaded', queueTabStateSnapshot);
  next.on('mode-changed', queueTabStateSnapshot);
}

export function createTabState(): DiagTabState {
  try {
    const allProblems = [...getProblems()].sort((a, b) => b.at - a.at);
    const shown = allProblems.slice(0, 100);
    return {
      tab: diagnosticsCollector.tab,
      version: RV_VERSION.version,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      url: typeof location === 'undefined' ? '' : redactUrl(location.href),
      mode: viewer?.modes.activeMode ?? 'unknown',
      ...(viewer?.currentModelUrl ? { model: redactUrl(viewer.currentModelUrl) } : {}),
      hmi: {
        reactRootMounted: typeof document !== 'undefined' && !!document.getElementById('react-root'),
        uiContext: [...getActiveContexts()].slice(0, 32),
        hmiVisible: getHmiVisible(),
      },
      webgpu: viewer?.rendererKind === 'webgpu',
      problems: shown.map(p => ({ id: p.id, severity: p.severity, title: p.title.slice(0, 300) })),
      ...(allProblems.length > shown.length ? { problemsTruncated: allProblems.length - shown.length } : {}),
    };
  } catch {
    return {
      tab: diagnosticsCollector.tab, version: RV_VERSION.version, userAgent: '', url: '', mode: 'unknown',
      hmi: { reactRootMounted: false, uiContext: [], hmiVisible: true }, webgpu: false, problems: [],
    };
  }
}

export function createTabStateEntry(): DiagEntry {
  return {
    t: new Date().toISOString(), src: 'web', lvl: 'info', kind: 'state', state: createTabState(),
    cat: 'state', msg: 'Tab state', tab: diagnosticsCollector.tab,
  };
}

export function queueTabStateSnapshot(): DiagEntry {
  const entry = createTabStateEntry();
  diagnosticsStreamer.enqueue(entry);
  return entry;
}

export async function flushDiagnosticsStreamer(): Promise<void> {
  await diagnosticsStreamer.flushAndWait();
}
