// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-transition-store — masks scene-destroying transitions (plan-410 F4).
 *
 * `loadModel()` clears the current scene BEFORE the new one is parsed, so every
 * mode entry/exit and every editor test round-trip shows an empty canvas for as
 * long as the load takes. This store drives one small overlay over that gap.
 *
 * Two ways to show it, and the difference is the whole point:
 *
 *  - {@link showNowAndPaint} — for DESTRUCTIVE transitions. It resolves only
 *    after the overlay has actually been COMMITTED BY REACT AND PAINTED, so the
 *    caller can await it and know the canvas is covered before it starts
 *    tearing the scene down. A synchronous store write would not do: React
 *    commits asynchronously and would land after `clearModel` (review finding
 *    R2-5).
 *  - {@link showDelayed} — for non-destructive waits where valid content stays
 *    on screen. Appears only if the wait exceeds {@link SHOW_DELAY_MS}, so a
 *    fast operation never flashes an overlay.
 *
 * Tokens, not booleans: transitions nest (an editor exit restores a scene while
 * a test stop is still unwinding), so the overlay hides when the LAST holder
 * releases. Once visible it stays up for at least {@link MIN_VISIBLE_MS} —
 * a 30 ms flash reads as a glitch, not as feedback.
 *
 * Lives in `core/hmi` and is rendered by the always-mounted HMI shell, NOT by a
 * plugin slot: the editor's exit overlay has to outlive the editor plugin that
 * requested it (review finding R2-2).
 */

/** Delay before a non-destructive wait shows the overlay. */
const SHOW_DELAY_MS = 200;
/** Minimum time the overlay stays up once it became visible. */
const MIN_VISIBLE_MS = 400;
/**
 * How long {@link showNowAndPaint} waits for a paint report before continuing
 * anyway. Without an overlay mounted (unit tests, headless embeddings) nobody
 * ever reports, and a scene transition must never hang on cosmetics.
 */
const PAINT_TIMEOUT_MS = 300;

/** Opaque handle identifying one show request. */
export type SceneTransitionToken = number;

export interface SceneTransitionSnapshot {
  visible: boolean;
  label: string;
}

interface Holder {
  label: string;
  /** Timer id while the holder is still in its show-delay. */
  delayTimer: ReturnType<typeof setTimeout> | null;
  /** True once this holder actually wants the overlay on screen. */
  showing: boolean;
}

const _holders = new Map<SceneTransitionToken, Holder>();
let _nextToken: SceneTransitionToken = 1;

let _snapshot: SceneTransitionSnapshot = { visible: false, label: '' };
const _listeners = new Set<() => void>();

/**
 * True while the full-screen branded loading splash (`#loading-overlay`,
 * owned by main.ts) is on screen. While it is, THIS overlay stays suppressed:
 * the splash already covers the canvas, which is the only job a destructive
 * transition needs done — showing "Opening editor…" on top of it is a second
 * loading indicator over a first one. The moment the splash goes, a still-held
 * transition surfaces, so the two are SEQUENTIAL rather than stacked.
 * main.ts reports both edges through {@link setBrandedSplashVisible}.
 */
let _splashVisible = false;

export function setBrandedSplashVisible(visible: boolean): void {
  if (_splashVisible === visible) return;
  _splashVisible = visible;
  _publish();
}

/** When the overlay became visible (for the minimum-display rule). */
let _visibleSince = 0;
/** Pending "hide after the minimum display time" timer. */
let _hideTimer: ReturnType<typeof setTimeout> | null = null;

/** Bumped on every state publish; the overlay reports which one it painted. */
let _version = 0;
/** Highest version the mounted overlay has confirmed on screen. */
let _paintedVersion = 0;
/** Whether an overlay component is mounted at all. */
let _overlayMounted = false;
const _paintWaiters: Array<{ version: number; resolve: () => void }> = [];

function _publish(): void {
  const showing = !_splashVisible && [..._holders.values()].some((h) => h.showing);
  const label = [..._holders.values()].reverse().find((h) => h.showing)?.label ?? _snapshot.label;
  if (showing === _snapshot.visible && label === _snapshot.label) return;
  if (showing && !_snapshot.visible) _visibleSince = Date.now();
  _snapshot = { visible: showing, label };
  _version++;
  for (const fn of _listeners) fn();
}

/** Resolve every waiter satisfied by `version` (or by giving up on it). */
function _drainPaintWaiters(version: number): void {
  for (let i = _paintWaiters.length - 1; i >= 0; i--) {
    if (_paintWaiters[i].version <= version) {
      const [w] = _paintWaiters.splice(i, 1);
      w.resolve();
    }
  }
}

function _waitForPaint(version: number): Promise<void> {
  if (_paintedVersion >= version) return Promise.resolve();
  if (!_overlayMounted) {
    // Nothing will ever report — do not hold the transition hostage.
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    _paintWaiters.push({ version, resolve: done });
    setTimeout(() => {
      if (settled) return;
      const i = _paintWaiters.findIndex((w) => w.resolve === done);
      if (i >= 0) _paintWaiters.splice(i, 1);
      done();
    }, PAINT_TIMEOUT_MS);
  });
}

function _hideNow(token: SceneTransitionToken): void {
  const holder = _holders.get(token);
  if (holder?.delayTimer) clearTimeout(holder.delayTimer);
  _holders.delete(token);
  _publish();
}

/**
 * Show the overlay and resolve once it is on screen — call this BEFORE any
 * `loadModel`/`clearModel`. Always release the returned token in a `finally`.
 */
export async function showNowAndPaint(label: string): Promise<SceneTransitionToken> {
  const token = _nextToken++;
  _holders.set(token, { label, delayTimer: null, showing: true });
  _publish();
  await _waitForPaint(_version);
  return token;
}

/**
 * Show the overlay only if the wait outlasts {@link SHOW_DELAY_MS}. For
 * non-destructive waits, where the scene on screen is still valid.
 */
export function showDelayed(label: string): SceneTransitionToken {
  const token = _nextToken++;
  const holder: Holder = { label, delayTimer: null, showing: false };
  holder.delayTimer = setTimeout(() => {
    holder.delayTimer = null;
    holder.showing = true;
    _publish();
  }, SHOW_DELAY_MS);
  _holders.set(token, holder);
  return token;
}

/**
 * Release a token. The overlay disappears when the last holder lets go — never
 * before it has been visible for {@link MIN_VISIBLE_MS}.
 */
export function hide(token: SceneTransitionToken): void {
  const holder = _holders.get(token);
  if (!holder) return;
  // A holder still inside its delay never showed anything: drop it at once.
  if (!holder.showing || !_snapshot.visible) { _hideNow(token); return; }

  const shown = Date.now() - _visibleSince;
  if (shown >= MIN_VISIBLE_MS) { _hideNow(token); return; }

  holder.showing = false;
  if ([..._holders.values()].some((h) => h.showing)) { _hideNow(token); return; }
  if (_hideTimer) clearTimeout(_hideTimer);
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    _hideNow(token);
  }, MIN_VISIBLE_MS - shown);
}

/** Run `fn` under a destructive-transition overlay; released in every path. */
export async function withSceneTransition<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const token = await showNowAndPaint(label);
  try {
    return await fn();
  } finally {
    hide(token);
  }
}

// ─── React store plumbing ───────────────────────────────────────────────

export function subscribeSceneTransition(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getSceneTransitionSnapshot(): SceneTransitionSnapshot {
  return _snapshot;
}

/** The overlay component announces its presence for the whole mount. */
export function setSceneTransitionOverlayMounted(mounted: boolean): void {
  _overlayMounted = mounted;
  if (!mounted) _drainPaintWaiters(Number.MAX_SAFE_INTEGER);
}

/**
 * The overlay reports that the CURRENT state is on screen (called after commit
 * + a rAF boundary). Resolves everyone waiting for that version or older.
 */
export function reportSceneTransitionPainted(): void {
  _paintedVersion = _version;
  _drainPaintWaiters(_paintedVersion);
}

/** Test-only: drop all holders, timers and waiters. */
export function _resetSceneTransition(): void {
  for (const holder of _holders.values()) {
    if (holder.delayTimer) clearTimeout(holder.delayTimer);
  }
  _holders.clear();
  _splashVisible = false;
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  _drainPaintWaiters(Number.MAX_SAFE_INTEGER);
  _snapshot = { visible: false, label: '' };
  _version = 0;
  _paintedVersion = 0;
  _visibleSince = 0;
  _overlayMounted = false;
}
