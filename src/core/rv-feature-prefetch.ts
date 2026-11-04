// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-feature-prefetch.ts — prefetch of on-demand features (plan-652 section 2.4.6).
 *
 * Two independent parts:
 *
 * - **Intent** (`createIntentPrefetcher`): hovering or focusing a mode entry in the mode
 *   dropdown starts the import of the mode's feature bodies after 80 ms (`features.preload`,
 *   import WITHOUT activate); leaving the entry earlier cancels, pressing it imports at once.
 *   The click that follows finds the chunk already in flight or done.
 * - **Idle** (`scheduleIdlePrefetch`): after the first model is on screen and the browser is
 *   idle, one `<link rel="prefetch">` per chunk file of every declared, inactive feature
 *   (`feature-chunks.json`). Download only — no parse, no execution. Gated to desktop-class
 *   input (`pointer: fine`) and skipped on Save-Data or a slow connection.
 *
 * Neither part activates anything; activation stays with the mode guard, the component scan
 * or the command (FeatureLoader).
 */

import { featureChunkFiles } from './rv-feature-loader';

/** Hover/focus delay before an intent prefetch starts (ms). */
export const INTENT_PREFETCH_DELAY_MS = 80;
/** Fallback delay when `requestIdleCallback` is missing (Safari) (ms). */
export const IDLE_PREFETCH_FALLBACK_MS = 2000;

/** What prefetch needs of the FeatureLoader. */
export interface PrefetchLoader {
  statuses(): readonly { id: string; state: string; activation: readonly string[] }[];
  preload(id: string): void;
}

//! Ids of the declared, not yet active features a switch to `mode` would activate.
export function lazyFeaturesForMode(loader: PrefetchLoader | null | undefined, mode: string): string[] {
  if (!loader || typeof loader.statuses !== 'function') return [];
  const trigger = `mode:${mode}`;
  return loader.statuses()
    .filter((s) => s.state !== 'active' && s.state !== 'loading' && s.activation.includes(trigger))
    .map((s) => s.id);
}

/** Handlers the mode dropdown wires to each menu entry. */
export interface IntentPrefetcher {
  /** Pointer entered or focus reached the entry of `mode` — prefetch after the delay. */
  enter(mode: string): void;
  /** Pointer left the entry before the delay ran out — cancel. */
  leave(mode: string): void;
  /** Pointer pressed (touch has no hover) — prefetch now. */
  down(mode: string): void;
  /** Cancel every pending timer (menu closed, unmount). */
  cancelAll(): void;
}

//! Creates the intent prefetcher of one mode dropdown.
export function createIntentPrefetcher(
  getLoader: () => PrefetchLoader | null | undefined,
  delayMs = INTENT_PREFETCH_DELAY_MS,
): IntentPrefetcher {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const fire = (mode: string): void => {
    timers.delete(mode);
    const loader = getLoader();
    for (const id of lazyFeaturesForMode(loader, mode)) loader!.preload(id);
  };
  const cancel = (mode: string): void => {
    const t = timers.get(mode);
    if (t !== undefined) { clearTimeout(t); timers.delete(mode); }
  };
  return {
    enter(mode) {
      if (timers.has(mode) || lazyFeaturesForMode(getLoader(), mode).length === 0) return;
      timers.set(mode, setTimeout(() => fire(mode), delayMs));
    },
    leave: cancel,
    down(mode) {
      cancel(mode);
      fire(mode);
    },
    cancelAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

/** The browser facts the idle gate reads — injectable for tests. */
export interface IdlePrefetchEnv {
  matchMedia?: (query: string) => { matches: boolean };
  connection?: { saveData?: boolean; effectiveType?: string } | null;
}

const SLOW_CONNECTIONS = new Set(['slow-2g', '2g', '3g']);

//! True when idle prefetch is worth its bytes: fine pointer, no Save-Data, not a slow connection.
export function shouldIdlePrefetch(env: IdlePrefetchEnv = browserEnv()): boolean {
  let fine = false;
  try { fine = env.matchMedia?.('(pointer: fine)').matches === true; } catch { fine = false; }
  if (!fine) return false;
  // `navigator.connection` is Chromium-only; without it, nothing argues against prefetch.
  const c = env.connection;
  if (c?.saveData === true) return false;
  if (c?.effectiveType && SLOW_CONNECTIONS.has(c.effectiveType)) return false;
  return true;
}

function browserEnv(): IdlePrefetchEnv {
  if (typeof window === 'undefined') return {};
  const nav = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
    : undefined;
  return {
    matchMedia: typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
    connection: nav?.connection ?? null,
  };
}

/** Seams of `scheduleIdlePrefetch` — tests inject them, the app takes the browser's. */
export interface IdlePrefetchOptions {
  env?: IdlePrefetchEnv;
  /** Chunk files of a feature (default: `feature-chunks.json` via `featureChunkFiles`). */
  filesOf?: (id: string) => readonly string[];
  /** Waits for idle time; default `requestIdleCallback ?? setTimeout(…, 2000)`. */
  whenIdle?: (cb: () => void) => void;
  /** Adds one prefetch hint; default appends `<link rel="prefetch" crossorigin>` to `<head>`. */
  addHint?: (href: string) => void;
}

//! Schedules the idle prefetch of every declared, inactive on-demand feature (gated, see shouldIdlePrefetch).
export function scheduleIdlePrefetch(loader: PrefetchLoader | null | undefined, options: IdlePrefetchOptions = {}): void {
  if (!loader || typeof loader.statuses !== 'function') return;
  if (!shouldIdlePrefetch(options.env)) return;
  const whenIdle = options.whenIdle ?? defaultWhenIdle;
  whenIdle(() => {
    const filesOf = options.filesOf ?? featureChunkFiles;
    const addHint = options.addHint ?? addPrefetchLink;
    const seen = new Set<string>();
    for (const s of loader.statuses()) {
      if (s.state !== 'declared') continue;
      if (!s.activation.some((t) => t !== 'startup')) continue;
      for (const file of filesOf(s.id)) {
        if (seen.has(file)) continue;
        seen.add(file);
        addHint(file);
      }
    }
  });
}

function defaultWhenIdle(cb: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: 10_000 });
  else setTimeout(cb, IDLE_PREFETCH_FALLBACK_MS);
}

/**
 * `crossorigin` (anonymous) matches the request a dynamic `import()` makes (CORS mode,
 * same-origin credentials, like Vite's own modulepreload links) — so the later import can
 * be served from the same HTTP cache entry (plan-652 Phase 4 browser check).
 */
function addPrefetchLink(file: string): void {
  if (typeof document === 'undefined') return;
  const href = new URL(file, document.baseURI).href;
  for (const existing of document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]')) {
    if (existing.href === href) return;
  }
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.as = 'script';
  link.crossOrigin = 'anonymous';
  link.href = href;
  document.head.appendChild(link);
}
