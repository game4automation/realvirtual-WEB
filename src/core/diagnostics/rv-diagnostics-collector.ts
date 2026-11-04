// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { setLogSink, type LogEntry } from '../engine/rv-debug';
import { setOnRootError } from '../hmi/RootErrorBoundary';
import { redactDiagnosticsText } from './rv-diagnostics-redact';

export interface DiagEntry {
  t: string;
  src: 'web';
  lvl: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  kind?: 'log' | 'state';
  state?: DiagTabState;
  component?: string;
  cat: string;
  msg: string;
  stack?: string;
  tab?: string;
  rep?: number;
}

export interface DiagTabState {
  tab: string; version: string; userAgent: string; url: string;
  mode: string; model?: string;
  hmi: { reactRootMounted: boolean; uiContext: string[]; hmiVisible: boolean };
  bridgeRole?: 'active' | 'standby'; webgpu: boolean;
  problems: { id: string; severity: string; title: string }[];
  problemsTruncated?: number;
}

const WINDOW_MS = 15 * 60_000;
const MAX_ENTRIES = 5000;
const FLOOD_LIMIT = 50;
const MAX_ARG_LEN = 2000;

/** Crash-safe serializer shared by console capture and the DEV debug endpoint. */
export function serializeConsoleArg(arg: unknown): string {
  try {
    if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
    if (arg === null || typeof arg !== 'object') return String(arg).slice(0, MAX_ARG_LEN);
    const o = arg as Record<string, unknown>;
    const kind = o.isBufferGeometry ? 'BufferGeometry' :
      (o.isBufferAttribute || o.isInterleavedBufferAttribute) ? 'BufferAttribute' :
      o.isObject3D ? 'Object3D' : o.isMaterial ? 'Material' : o.isTexture ? 'Texture' : '';
    if (kind) {
      const type = typeof o.type === 'string' && o.type !== kind ? ` type=${o.type}` : '';
      const name = typeof o.name === 'string' && o.name ? ` name=${o.name}` : '';
      const uuid = typeof o.uuid === 'string' ? ` uuid=${o.uuid}` : '';
      return `[${kind}${type}${name}${uuid}]`;
    }
    return (JSON.stringify(arg) ?? String(arg)).slice(0, MAX_ARG_LEN);
  } catch {
    try { return String(arg).slice(0, MAX_ARG_LEN); } catch { return '[unserializable]'; }
  }
}

/** Message text for an entry whose stack is stored separately: no stack inside `msg`. */
function errorMessage(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : serializeConsoleArg(value);
}

export function isChunkLoadError(value: unknown): boolean {
  const text = value instanceof Error ? `${value.name} ${value.message}` : String(value);
  return /failed to fetch dynamically imported module|loading chunk|chunkloaderror|importing a module script failed/i.test(text);
}

type EntryListener = (entry: DiagEntry) => void;

class DiagnosticsCollector {
  readonly tab = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private entries: DiagEntry[] = [];
  private listeners = new Set<EntryListener>();
  private adding = false;
  private flood = new Map<string, { start: number; count: number; collapsed?: DiagEntry }>();

  add(input: Omit<DiagEntry, 't' | 'src' | 'tab'> & { t?: string }): void {
    if (this.adding) return;
    this.adding = true;
    try {
      const now = input.t ? Date.parse(input.t) : Date.now();
      const msg = redactDiagnosticsText(input.msg).slice(0, 8000);
      const key = `${input.lvl}\0${input.cat}\0${msg}`;
      let burst = this.flood.get(key);
      if (!burst || now - burst.start >= 1000) {
        burst = { start: now, count: 0 };
        this.flood.set(key, burst);
        if (this.flood.size > MAX_ENTRIES) this.flood.delete(this.flood.keys().next().value!);
      }
      burst.count++;
      if (burst.count > FLOOD_LIMIT) {
        if (burst.collapsed) burst.collapsed.rep = (burst.collapsed.rep ?? 1) + 1;
        else {
          const entry = this.makeEntry(input, msg);
          entry.rep = 1;
          burst.collapsed = entry;
          this.push(entry, now);
        }
        return;
      }
      this.push(this.makeEntry(input, msg), now);
    } finally { this.adding = false; }
  }

  getEntries(options: { sinceMs?: number } = {}): DiagEntry[] {
    this.prune(Date.now());
    const since = options.sinceMs === undefined ? -Infinity : Date.now() - options.sinceMs;
    return this.entries.filter(e => Date.parse(e.t) >= since).map(e => ({ ...e }));
  }

  subscribe(listener: EntryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void { this.entries = []; this.flood.clear(); }

  private makeEntry(input: Omit<DiagEntry, 't' | 'src' | 'tab'> & { t?: string }, msg: string): DiagEntry {
    return {
      ...input, t: input.t ?? new Date().toISOString(), src: 'web', tab: this.tab, msg,
      ...(input.stack ? { stack: redactDiagnosticsText(input.stack).slice(0, 16000) } : {}),
      ...(input.component ? { component: redactDiagnosticsText(input.component) } : {}),
    };
  }

  private push(entry: DiagEntry, now: number): void {
    this.entries.push(entry);
    this.prune(now);
    for (const listener of this.listeners) {
      try { listener({ ...entry }); } catch { /* subscriber isolation */ }
    }
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    let remove = 0;
    while (remove < this.entries.length && Date.parse(this.entries[remove].t) < cutoff) remove++;
    if (remove) this.entries.splice(0, remove);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }
}

export const diagnosticsCollector = new DiagnosticsCollector();
let installed = false;

function captureRvDebug(entry: LogEntry): void {
  diagnosticsCollector.add({ lvl: entry.level, cat: entry.category, msg: entry.message, stack: entry.stack });
}

/** Record a chunk failure caught by a React lazy-panel boundary. */
export function captureChunkError(error: unknown, component?: string): void {
  diagnosticsCollector.add({
    lvl: 'error', cat: 'chunk', msg: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined, component,
  });
}

/** Install all global capture hooks once. */
export function installDiagnosticsCollector(): typeof diagnosticsCollector {
  if (installed || typeof window === 'undefined') return diagnosticsCollector;
  installed = true;
  setLogSink(captureRvDebug);

  const originalError = console.error;
  const originalWarn = console.warn;
  const wrap = (level: 'warn' | 'error', original: (...args: unknown[]) => void) => (...args: unknown[]) => {
    try {
      if (!(typeof args[0] === 'string' && args[0].startsWith('[RootErrorBoundary]'))) {
        diagnosticsCollector.add({ lvl: level, cat: 'console', msg: args.map(serializeConsoleArg).join(' ').slice(0, 8000) });
      }
    } finally { original.apply(console, args); }
  };
  console.error = wrap('error', originalError);
  console.warn = wrap('warn', originalWarn);

  window.addEventListener('error', event => {
    const target = event.target;
    const resource = target instanceof HTMLScriptElement || target instanceof HTMLLinkElement;
    let resourceUrl = '';
    if (target instanceof HTMLScriptElement) resourceUrl = target.src;
    else if (target instanceof HTMLLinkElement) resourceUrl = target.href;
    const value = event.error ?? event.message ?? (resource ? resourceUrl || 'Resource load failed' : 'Resource load failed');
    diagnosticsCollector.add({
      lvl: 'error', cat: resource || isChunkLoadError(value) ? 'chunk' : 'window',
      msg: errorMessage(value), stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  }, true);
  window.addEventListener('unhandledrejection', event => {
    diagnosticsCollector.add({
      lvl: 'error', cat: isChunkLoadError(event.reason) ? 'chunk' : 'window',
      msg: errorMessage(event.reason), stack: event.reason instanceof Error ? event.reason.stack : undefined,
    });
  });
  setOnRootError((error, component) => diagnosticsCollector.add({
    lvl: 'error', cat: 'react', msg: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined, component,
  }));
  return diagnosticsCollector;
}

export function getDiagnosticsEntries(options?: { sinceMs?: number }): DiagEntry[] {
  return diagnosticsCollector.getEntries(options);
}

export function subscribeDiagnosticsEntries(listener: EntryListener): () => void {
  return diagnosticsCollector.subscribe(listener);
}
