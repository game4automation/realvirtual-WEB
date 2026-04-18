// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Generic Instruction Overlay — central pub/sub store.
 *
 * A unified primitive for showing positional text/callouts/banners anchored to
 * 3D scene nodes, HMI DOM elements, screen coordinates, or canvas edges. Used
 * by Kiosk (Plan 150), future Maintenance migration (Plan 152), and future
 * LogicStep runtime instructions.
 *
 * Pattern matches `pdf-viewer-store.tsx` / `message-panel-store.ts`:
 *  - Module-level state
 *  - `useSyncExternalStore`-compatible (reference-stable snapshot)
 *  - Listener set with per-listener error isolation
 *
 * Key invariants:
 *  - `showInstruction(sameId)` REPLACES (Map.set semantics); never stacks
 *  - `getInstructions()` returns the same frozen array reference between
 *    calls unless state changes (critical for React 18 Strict Mode)
 *  - `_warnOnce(kind, id, msg)` dedup keyed by `'${kind}:${id}'` — cleaned
 *    on hideInstruction / clearBySource so re-shown instructions can warn again
 *  - Hard cap `MAX_ACTIVE = 20`; lowest-priority FIFO-evicted on overflow
 *
 * @public @stable v1 — the public surface (showInstruction, hideInstruction,
 *   clearBySource, getInstructions, useInstructions, Instruction* types)
 *   is frozen for v1. Additions to anchor kinds / style variants are
 *   backwards-compatible; removals require a major version bump.
 */

import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

// ─── Types (public @stable v1) ──────────────────────────────────────────

/** Where the instruction visually attaches. @public @stable v1 */
export type InstructionAnchor =
  | { kind: 'node'; path: string; offset?: [number, number] }
  | { kind: 'hmi-element'; elementId: string; placement?: 'above' | 'below' | 'left' | 'right' }
  | { kind: 'screen'; x: number; y: number }
  | { kind: 'canvas-center' }
  | { kind: 'edge'; edge: 'top' | 'bottom' | 'left' | 'right' };

/** Visual style bucket. @public @stable v1 */
export type InstructionStyle =
  | 'banner'
  | 'callout'
  | 'toast'
  | 'pill'
  | 'warning'
  | 'info';

/** Action button inside an instruction (optional). @public @stable v1 */
export interface InstructionAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'text';
}

/** Single instruction payload. @public @stable v1 */
export interface Instruction {
  id: string;
  text?: string;
  content?: ReactNode;
  anchor: InstructionAnchor;
  style?: InstructionStyle;
  actions?: InstructionAction[];
  autoClearAfterMs?: number;
  priority?: number;
  source?: string;
  dismissible?: boolean;
  onDismiss?: () => void;
}

// ─── Enum validation sets (internal) ────────────────────────────────────

const VALID_ANCHOR_KINDS = ['node', 'hmi-element', 'screen', 'canvas-center', 'edge'] as const;
const VALID_EDGE_KINDS = ['top', 'bottom', 'left', 'right'] as const;
const VALID_STYLES: readonly InstructionStyle[] = ['banner', 'callout', 'toast', 'pill', 'warning', 'info'];

// ─── Module-level state ─────────────────────────────────────────────────

const _instructions = new Map<string, Instruction>();
const _listeners = new Set<() => void>();
const _timers = new Map<string, ReturnType<typeof setTimeout>>();
const _warnedIds = new Set<string>();
const MAX_ACTIVE = 20;

/**
 * Cached sorted snapshot — reference-stable until state changes.
 * CRITICAL for `useSyncExternalStore` correctness: getSnapshot() MUST return
 * the same reference between calls when state is unchanged, otherwise React 18
 * strict mode detects "infinite getSnapshot loop" because fresh arrays never
 * satisfy Object.is.
 */
let _snapshot: readonly Instruction[] = Object.freeze([]);

// ─── Validation (internal) ──────────────────────────────────────────────

/** @internal — runtime validation against bad input (LogicStep JSON, plugin typos). */
export function normalizeInstruction(raw: unknown): Instruction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Instruction>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if ((r.text === undefined || r.text === null) && r.content === undefined) return null;
  if (!r.anchor || typeof r.anchor !== 'object') return null;
  const anchor = r.anchor as InstructionAnchor;
  const anchorKind = anchor.kind;
  if (!VALID_ANCHOR_KINDS.includes(anchorKind as (typeof VALID_ANCHOR_KINDS)[number])) return null;

  if (anchorKind === 'node') {
    const a = anchor as Extract<InstructionAnchor, { kind: 'node' }>;
    if (typeof a.path !== 'string' || a.path.length === 0) return null;
  } else if (anchorKind === 'hmi-element') {
    const a = anchor as Extract<InstructionAnchor, { kind: 'hmi-element' }>;
    if (typeof a.elementId !== 'string' || a.elementId.length === 0) return null;
  } else if (anchorKind === 'screen') {
    const a = anchor as Extract<InstructionAnchor, { kind: 'screen' }>;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
  } else if (anchorKind === 'edge') {
    const a = anchor as Extract<InstructionAnchor, { kind: 'edge' }>;
    if (!VALID_EDGE_KINDS.includes(a.edge as (typeof VALID_EDGE_KINDS)[number])) return null;
  }

  if (r.style !== undefined && !VALID_STYLES.includes(r.style)) return null;

  return {
    id: r.id,
    text: r.text,
    content: r.content,
    anchor,
    style: r.style ?? 'info',
    actions: Array.isArray(r.actions) ? r.actions : undefined,
    autoClearAfterMs:
      typeof r.autoClearAfterMs === 'number' && Number.isFinite(r.autoClearAfterMs) && r.autoClearAfterMs > 0
        ? r.autoClearAfterMs
        : undefined,
    priority: typeof r.priority === 'number' && Number.isFinite(r.priority) ? r.priority : 0,
    source: typeof r.source === 'string' ? r.source : undefined,
    dismissible: r.dismissible === true,
    onDismiss: typeof r.onDismiss === 'function' ? r.onDismiss : undefined,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Show or update an instruction. If an instruction with the same `id` exists,
 * it is replaced (including its auto-clear timer).
 *
 * @public @stable v1
 */
export function showInstruction(inst: Instruction): void {
  const normalized = normalizeInstruction(inst);
  if (!normalized) {
    // Log-once per (kind:id) to prevent spam from repeated bad calls
    const rawId = (inst as Partial<Instruction> | null | undefined)?.id ?? 'unknown';
    const key = `invalid:${rawId}`;
    if (!_warnedIds.has(key)) {
      console.warn('[instruction] rejected invalid payload', inst);
      _warnedIds.add(key);
    }
    return;
  }
  // Evict lowest-priority (FIFO within tie) if over cap and inserting new id
  if (_instructions.size >= MAX_ACTIVE && !_instructions.has(normalized.id)) {
    _evictLowestPriority();
  }
  // Clear prior timer for this id (replace semantics — no timer stacking)
  const prior = _timers.get(normalized.id);
  if (prior !== undefined) { clearTimeout(prior); _timers.delete(normalized.id); }
  _instructions.set(normalized.id, normalized);
  if (normalized.autoClearAfterMs !== undefined) {
    const handle = setTimeout(() => hideInstruction(normalized.id), normalized.autoClearAfterMs);
    _timers.set(normalized.id, handle);
  }
  _notify();
}

/**
 * Hide a specific instruction by id. No-op if id not present.
 * @public @stable v1
 */
export function hideInstruction(id: string): void {
  const t = _timers.get(id);
  if (t !== undefined) { clearTimeout(t); _timers.delete(id); }
  if (_instructions.delete(id)) {
    // Clear per-id warn-keys so re-showing the same id can warn again
    _warnedIds.delete(`missing-node:${id}`);
    _warnedIds.delete(`missing-elem:${id}`);
    _warnedIds.delete(`invalid:${id}`);
    _notify();
  }
}

/**
 * Remove all instructions whose `source` matches. Used by plugins on dispose
 * to guarantee their instructions don't leak. Zero-op if source has no entries.
 * @public @stable v1
 */
export function clearBySource(source: string): void {
  let changed = false;
  for (const [id, inst] of _instructions) {
    if (inst.source === source) {
      const t = _timers.get(id);
      if (t !== undefined) { clearTimeout(t); _timers.delete(id); }
      _instructions.delete(id);
      _warnedIds.delete(`missing-node:${id}`);
      _warnedIds.delete(`missing-elem:${id}`);
      _warnedIds.delete(`invalid:${id}`);
      changed = true;
    }
  }
  if (changed) _notify();
}

/**
 * Read-only snapshot of active instructions, sorted by priority descending
 * (highest priority first; stable order for equal priorities).
 *
 * Returns the cached snapshot; a new frozen array is only produced when state
 * changes via `_rebuildSnapshot()` in `_notify()`. Reference-stable for
 * `useSyncExternalStore`.
 *
 * @public @stable v1
 */
export function getInstructions(): readonly Instruction[] {
  return _snapshot;
}

/**
 * Subscribe to instruction-store changes. Returns unsubscribe function.
 * Typical consumers should prefer the `useInstructions()` React hook.
 * @internal — use `useInstructions()` in React components.
 */
export function subscribeInstructions(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * React hook: subscribes to instruction-store and returns current snapshot,
 * sorted by priority descending.
 * @public @stable v1
 */
export function useInstructions(): readonly Instruction[] {
  return useSyncExternalStore(subscribeInstructions, getInstructions, getInstructions);
}

/** @internal — record a log-once warning keyed by (kind, id). Prevents console spam. */
export function _warnOnce(kind: 'missing-node' | 'missing-elem', id: string, msg: string): void {
  const key = `${kind}:${id}`;
  if (_warnedIds.has(key)) return;
  _warnedIds.add(key);
  console.warn(msg);
}

/**
 * TEST-ONLY — clears all instructions, listeners, timers. For unit test isolation.
 * Production-guarded: throws if called in a production build.
 * @internal
 */
export function _resetStoreForTests(): void {
  if (import.meta.env.PROD) {
    throw new Error('_resetStoreForTests() must not be called in production');
  }
  for (const t of _timers.values()) clearTimeout(t);
  _instructions.clear();
  _timers.clear();
  _warnedIds.clear();
  _listeners.clear();
  _snapshot = Object.freeze([]);
}

// ─── Internal helpers ───────────────────────────────────────────────────

function _rebuildSnapshot(): void {
  _snapshot = Object.freeze(
    Array.from(_instructions.values()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
  );
}

function _notify(): void {
  _rebuildSnapshot();   // must come BEFORE listener fan-out
  for (const l of _listeners) {
    try { l(); } catch (e) { console.error('[instruction] listener threw:', e); }
  }
}

function _evictLowestPriority(): void {
  let victim: string | null = null;
  let minPrio = Infinity;
  for (const [id, inst] of _instructions) {
    const p = inst.priority ?? 0;
    if (p < minPrio) { minPrio = p; victim = id; }
  }
  if (victim !== null) {
    console.debug(`[instruction] evicted '${victim}' due to cap (${MAX_ACTIVE})`);
    hideInstruction(victim);
  }
}
