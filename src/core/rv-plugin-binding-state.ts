// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-plugin-binding-state.ts — what happened to the document's plugin binding
 * (plan-479 Phase 4 / F6).
 *
 * `documents[].scriptRef` says what SHOULD load. Whether it did was, until this
 * file, knowable only from `debugWarn` lines in the browser console — which is
 * the same as not knowable, for the person who made the binding by dragging a
 * card onto it. The chip could say "bound" while nothing ran.
 *
 * The store publishes exactly what the manager already knew and threw away. It
 * invents no new diagnosis: every `reason` corresponds to a place where
 * `rv-model-plugin-manager.ts` currently emits a warning, plus the `register`
 * call itself, which is the one failure the manager logs to `console.error`.
 *
 * It lives in `core/` and not in the UI layer on purpose. The dependency
 * direction stays "core publishes state, hmi consumes it through a hook" — the
 * same shape as `connect-store` and `project-store`, and the reason the manager
 * can report without importing anything from `hmi/`.
 *
 * Its own module rather than a section of the manager: the manager is imported
 * by the viewer boot path, the store is read by a React chip, and keeping them
 * apart is what lets a test of the state machine cost nothing.
 */

/** Why a binding did not end up running. One value per diagnosis site. */
export type PluginBindingFailure =
  /** The reference matched no module in the build and no runnable `.js`. */
  | 'unresolved'
  /** The module was found and importing it threw. */
  | 'import-failed'
  /** It imported, and carries no registerModelPlugins/unregisterModelPlugins pair. */
  | 'no-exports'
  /** It imported and `registerModelPlugins` threw. */
  | 'register-threw';

/** The document's plugin binding, as the last load left it. */
export type PluginBindingState =
  /** No document is open, or the open one names no script. */
  | { kind: 'none' }
  /** A reference is set; no load has spoken about it yet. */
  | { kind: 'bound'; scriptRef: string }
  | { kind: 'loaded'; scriptRef: string; from: 'bundle' | 'runtime' }
  | {
      kind: 'failed';
      scriptRef: string;
      reason: PluginBindingFailure;
      /** One sentence, fit for a tooltip. Never empty. */
      detail: string;
    };

const NONE: PluginBindingState = { kind: 'none' };

let _state: PluginBindingState = NONE;
const _listeners = new Set<() => void>();

/** Subscribe half of the `useSyncExternalStore` pair. */
export function subscribePluginBindingState(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * Snapshot half of the pair — the SAME object until something really changed.
 *
 * `useSyncExternalStore` compares by identity and re-renders on every new
 * object, so a getter that built its answer would spin the chip forever.
 */
export function getPluginBindingState(): PluginBindingState {
  return _state;
}

function publish(next: PluginBindingState): void {
  if (same(_state, next)) return;
  _state = next;
  for (const listener of [..._listeners]) listener();
}

/** Structural equality — enough to keep the identity stable across re-reports. */
function same(a: PluginBindingState, b: PluginBindingState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'none' || b.kind === 'none') return true;
  if (a.scriptRef !== (b as { scriptRef: string }).scriptRef) return false;
  if (a.kind === 'loaded' && b.kind === 'loaded') return a.from === b.from;
  if (a.kind === 'failed' && b.kind === 'failed') {
    return a.reason === b.reason && a.detail === b.detail;
  }
  return true;
}

// ─── The reporting surface, called from the plugin manager ──────────────

/**
 * A model is loading and its row names this script — nothing known yet.
 *
 * Reported BEFORE the resolution runs, so a resolution that hangs shows
 * "bound" rather than the previous document's verdict.
 */
export function reportPluginBinding(scriptRef: string | null | undefined): void {
  const ref = String(scriptRef ?? '').trim();
  publish(ref === '' ? NONE : { kind: 'bound', scriptRef: ref });
}

/** The module resolved, imported and registered. */
export function reportPluginLoaded(scriptRef: string, from: 'bundle' | 'runtime'): void {
  const ref = String(scriptRef ?? '').trim();
  if (ref === '') return;
  publish({ kind: 'loaded', scriptRef: ref, from });
}

/** The binding did not end up running, and this is which of the four reasons. */
export function reportPluginFailed(
  scriptRef: string,
  reason: PluginBindingFailure,
  detail: string,
): void {
  const ref = String(scriptRef ?? '').trim();
  if (ref === '') return;
  publish({ kind: 'failed', scriptRef: ref, reason, detail: detail || reason });
}

/**
 * Forget everything — a model closed, or the binding was cleared.
 *
 * Also what a document WITHOUT a `scriptRef` reports, so the chip of the next
 * document cannot inherit the verdict of the previous one.
 */
export function clearPluginBindingState(): void {
  publish(NONE);
}

/** Test seam: drop the state and every listener. */
export function resetPluginBindingStateForTests(): void {
  _state = NONE;
  _listeners.clear();
}
