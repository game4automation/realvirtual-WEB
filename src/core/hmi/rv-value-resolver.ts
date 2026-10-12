// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-value-resolver.ts — the single source-of-truth for property values shown
 * in the UI (property inspector, hierarchy badges, tooltips).
 *
 * Before this module, every UI surface hand-coded its own read path and they
 * diverged: only Drive had a live overlay, signal formatting was triplicated
 * with inconsistent precision, and editing a live field never reached the
 * running component. This module unifies all of that behind one rule.
 *
 * ── Precedence (one place, stated once) ─────────────────────────────────────
 *   static GLB config  →  overlay override  →  live runtime state   (live wins)
 *
 * The overlay is already folded into the static data: `updateOverlayField`
 * patches `node.userData.realvirtual` in place (see rv-extras-editor
 * `applyFieldToScene`), so callers read overlay-aware config straight from
 * userData. This module then overlays the component's authoritative live state
 * (`RVComponent.getLiveState()`) on top.
 *
 * For PLC signal component types the value comes from the SignalStore; the
 * path→name fallback lookup lives here (`readSignalValue`) so it is no longer
 * re-implemented in each consumer.
 *
 * Pure functions, no React. Uses a narrow `ResolverViewer` interface instead of
 * importing RVViewer to avoid a dependency cycle.
 */

import type { NodeRegistry } from '../engine/rv-node-registry';
import type { SignalStore } from '../engine/rv-signal-store';
import type { RVComponent, ComponentSchema } from '../engine/rv-component-registry';
import { getFieldDescriptor, isFieldDisplayReadonly } from '../engine/rv-component-registry';
import type { RVDrive } from '../engine/rv-drive';
import { FMU_TYPE, fmuStateOf } from '../engine/rv-fmu-constants';

/** Narrow view of RVViewer the resolver depends on (avoids an import cycle). */
export interface ResolverViewer {
  registry: NodeRegistry | null;
  signalStore: SignalStore | null;
  emit?(event: 'component-field-changed', data: {
    nodePath: string; componentType: string; fieldName: string;
  }): void;
}

const DASH = '—'; // em dash for "no value"

// ── Component-type helpers (kept local so this module has no hmi deps) ───────

/** True for PLC signal component types (PLCInput... or PLCOutput...). */
export function isSignalComponentType(type: string): boolean {
  return type.startsWith('PLCInput') || type.startsWith('PLCOutput');
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Strip a numeric instance suffix ("Drive_1" → "Drive") for schema lookup.
 *  Kept local (mirrors baseComponentType in rv-inspector-helpers) so this
 *  module stays free of hmi deps. */
function baseComponentType(type: string): string {
  return type.replace(/_\d+$/, '');
}

// ── Value formatting (THE single formatter) ──────────────────────────────────

export interface FormatOptions {
  /** Bool presentation: 'glyph' = ●/○ (badges), 'word' = true/false (inspector). */
  boolStyle?: 'glyph' | 'word';
  /** Truncate numbers to integers (PLCInputInt / PLCOutputInt). */
  intLike?: boolean;
  /** Decimal places for floats. Default 1 — standardized across all surfaces. */
  floatDigits?: number;
}

/** Format any display value consistently. This is the only place precision and
 *  bool presentation are decided. */
export function formatValue(value: unknown, opts: FormatOptions = {}): string {
  if (value === null || value === undefined) return DASH;
  if (typeof value === 'boolean') {
    if (opts.boolStyle === 'glyph') return value ? '●' : '○';
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return DASH;
    return opts.intLike ? String(Math.trunc(value)) : value.toFixed(opts.floatDigits ?? 1);
  }
  return String(value);
}

// ── Signal value reads (single path→name fallback) ───────────────────────────

/** Read a signal's current value by node path, falling back to its registered
 *  name (Signal.Name or node leaf name). Returns undefined when unregistered. */
export function readSignalValue(
  signalStore: SignalStore | null,
  nodePath: string,
  staticData?: Record<string, unknown>,
): boolean | number | undefined {
  if (!signalStore) return undefined;
  let value = signalStore.getByPath(nodePath);
  if (value === undefined) {
    const name = (staticData?.['Name'] as string) || lastSegment(nodePath);
    if (name) value = signalStore.get(name);
  }
  return value;
}

// ── Live state lookup ────────────────────────────────────────────────────────

/** Read a component instance's authoritative live state, or null when the type
 *  is not a registered live component (then UI falls back to static config).
 *  Used by the inspector's read-only Live section. */
export function getLiveStateFor(
  viewer: ResolverViewer,
  nodePath: string,
  componentType: string,
): Record<string, unknown> | null {
  const reg = viewer.registry;
  if (!reg) return null;
  const inst = reg.getByPath<RVComponent>(componentType, nodePath);
  if (!inst || typeof inst.getLiveState !== 'function') return null;
  try {
    return inst.getLiveState();
  } catch {
    // A throwing component must never break the inspector.
    return null;
  }
}

/** The merged field map representing the full current state of a component:
 *  static config (which already includes overlay edits) with live runtime state
 *  layered on top. This is a read-only "everything as it is right now" view —
 *  NOT used for the inspector's editable rows (those must be config-only so the
 *  override/save model stays coherent). Kept for read-only/export consumers. */
export function getDisplayState(
  viewer: ResolverViewer,
  nodePath: string,
  componentType: string,
  staticData: Record<string, unknown>,
): Record<string, unknown> {
  const live = getLiveStateFor(viewer, nodePath, componentType);
  return live ? { ...staticData, ...live } : staticData;
}

/** True when a field is ephemeral runtime state that must never be persisted as
 *  an override: the component exposes it via getLiveState() but it is NOT a
 *  schema (config) field. `Drive.TargetSpeed` is live AND schema → config, so
 *  not ephemeral; `Drive.CurrentPosition`, `Sensor.Occupied`,
 *  `TransportSurface.Speed` are live-only → ephemeral. Config-only fields
 *  (Locked, Visible, Splat inverts, …) are never live keys → not ephemeral. */
export function isEphemeralField(
  viewer: ResolverViewer,
  nodePath: string,
  componentType: string,
  fieldName: string,
): boolean {
  // Fail-safe: this runs on every inspector edit, so it must never throw.
  // When we can't determine ephemerality, default to "not ephemeral" (allow the
  // edit) — production always has a real registry; the unknown case is config.
  const reg = viewer.registry;
  if (!reg || typeof reg.getByPath !== 'function') return false;
  let live: Record<string, unknown>;
  try {
    const inst = reg.getByPath<RVComponent>(componentType, nodePath);
    if (!inst || typeof inst.getLiveState !== 'function') return false;
    live = inst.getLiveState();
    if (!(fieldName in live)) return false;
    const schema = (inst.constructor as { schema?: ComponentSchema }).schema;
    // Live AND in schema → a config setpoint (persistable). Live-only → ephemeral.
    return !(schema && fieldName in schema);
  } catch {
    return false;
  }
}

/** The single header/badge value for a component:
 *  - signal types → live signal value
 *  - Drive → live current position (+ unit)
 *  - Fmu → the instance state (`running`, `idle`, `error`, …; plan-510)
 *  - otherwise → null
 *  Returns both formatted `text` and the `raw` value so callers can choose a
 *  different presentation (e.g. glyph vs word) without re-reading. */
export function getPrimaryDisplayValue(
  viewer: ResolverViewer,
  nodePath: string,
  componentType: string,
  staticData: Record<string, unknown>,
): { text: string | null; raw: unknown } {
  if (isSignalComponentType(componentType)) {
    const value = readSignalValue(viewer.signalStore, nodePath, staticData);
    if (value === undefined) return { text: null, raw: undefined };
    return {
      text: formatValue(value, { boolStyle: 'word', intLike: componentType.includes('Int') }),
      raw: value,
    };
  }
  if (componentType === 'Drive') {
    const drive = viewer.registry?.getByPath<RVDrive>('Drive', nodePath) ?? null;
    if (drive) {
      const unit = drive.isRotary ? '°' : ' mm';
      return { text: drive.currentPosition.toFixed(1) + unit, raw: drive.currentPosition };
    }
  }
  if (baseComponentType(componentType) === FMU_TYPE) {
    const state = fmuStateOf(viewer.registry?.getNode(nodePath) ?? null);
    if (state) return { text: state, raw: state };
  }
  return { text: null, raw: undefined };
}

// ── Live edit (keeps the running component in sync with inspector edits) ─────

const SKIP = Symbol('skip');

/** Coerce an edited value to the component's schema field type. Returns SKIP
 *  for non-scalar fields (enum/vector/ref) — those are never part of live state
 *  and require a reload to take effect. */
function coerceScalar(inst: RVComponent, fieldName: string, value: unknown): unknown | typeof SKIP {
  const schema = (inst.constructor as { schema?: ComponentSchema }).schema;
  const desc = schema?.[fieldName];
  if (!desc) return SKIP;
  switch (desc.type) {
    case 'number':
      return Number(value);
    case 'boolean':
      return Boolean(value);
    case 'string':
      return String(value);
    default:
      return SKIP;
  }
}

/** Push an inspector edit into the live component instance so the change takes
 *  effect (and displays) immediately, without waiting for a scene reload.
 *
 *  Safe by construction:
 *  - Only scalar schema fields are applied (non-scalars are skipped).
 *  - Skipped entirely when the component is not the local owner (multiuser),
 *    so it never fights an authoritative server.
 *  - Components with a config↔runtime field split (e.g. Drive's `TargetSpeed`
 *    config vs `targetSpeed` runtime) implement `setLiveField` to apply both;
 *    otherwise the value is assigned to the same-named field. */
export function applyLiveEdit(
  viewer: ResolverViewer,
  nodePath: string,
  componentType: string,
  fieldName: string,
  value: unknown,
): void {
  // Never push a read-only schema field (readonly:true OR scope:'des') into the
  // live component — defense in depth, symmetric to the overlay write guard in
  // rv-extras-editor. Strip the instance suffix first (e.g. "Drive_1" → "Drive")
  // so the schema lookup matches, exactly as updateOverlayField does.
  if (isFieldDisplayReadonly(getFieldDescriptor(baseComponentType(componentType), fieldName))) return;

  const reg = viewer.registry;
  if (!reg) return;
  const inst = reg.getByPath<RVComponent>(componentType, nodePath);
  if (!inst || inst.isOwner === false) return;

  const coerced = coerceScalar(inst, fieldName, value);
  if (coerced === SKIP) return;

  // Component-owned mapping first (handles config↔runtime field splits).
  if (typeof inst.setLiveField === 'function' && inst.setLiveField(fieldName, coerced)) {
    viewer.emit?.('component-field-changed', { nodePath, componentType, fieldName });
    return;
  }

  // Generic: assign onto the same-named instance field if it exists.
  const bag = inst as unknown as Record<string, unknown>;
  if (fieldName in bag) {
    bag[fieldName] = coerced;
    viewer.emit?.('component-field-changed', { nodePath, componentType, fieldName });
  }
}
