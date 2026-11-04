// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drop-detection.ts — the `DropDetection` component (plan-2022).
 *
 * A part that nobody holds, that no belt carries and that has nothing beneath
 * it does not fall in the kinematic engine: it just stands in mid-air, and the
 * model builder never learns that the handover missed. Detection is on by
 * default, even without this component, and can be disabled in Settings.
 * This optional component tunes the scene-wide parameters and signal slots;
 * Enabled=false disables detection for the scene. The Settings switch takes
 * precedence. The first registered component wins; duplicates raise a problem.
 * Authored parameters travel with the GLB in rv_extras.
 *
 * The component itself owns no per-frame work: it hands its configuration to
 * the viewer-owned `RVDropManager` and unregisters on dispose, exactly like
 * `RVCollisionRole` does with the collision manager.
 */

import type { Object3D } from 'three';
// The STRUCTURE half of rv-odt.json (scripts/gen-odt-split.mjs): same `default` values, no
// descriptions. Importing the full rv-odt.json here put ~220 kB of descriptions into the entry
// chunk (bundle-splitting T5/T5b).
import rvOdt from '../../../schema/v1/rv-odt.structure.json';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import { wireBoolSignal } from './rv-signal-wiring';
import { slotDeclare, slotUndeclare, slotWrite } from './rv-slot-io';

// ─── Enum ────────────────────────────────────────────────────────────────

/**
 * Support modes. English, NOT localized — mirrored verbatim in rv-odt.json and
 * in the `enum(...)` cell of specification.md (`spec-tables-sync.test.ts`
 * compares them literally).
 */
export const SUPPORT_MODES = ['GeometryBelow', 'StateOnly'] as const;

export type SupportModeName = (typeof SUPPORT_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set<string>(SUPPORT_MODES);

/** Defensive parse of an arbitrary value into a support mode. Unknown →
 *  `'GeometryBelow'`; never throws (same contract as `toCollisionRole`). */
export function toSupportMode(value: unknown): SupportModeName {
  return typeof value === 'string' && MODE_SET.has(value)
    ? (value as SupportModeName)
    : 'GeometryBelow';
}

// ─── Configuration seam ──────────────────────────────────────────────────

/** The parameter set the manager reads. Times in seconds, distances in mm. */
export interface DropDetectionConfig {
  readonly Enabled: boolean;
  readonly GraceTime: number;
  readonly SupportProbeDistance: number;
  readonly SupportMode: SupportModeName;
  readonly SupportRecheckInterval: number;
  readonly DeleteUnsupported: boolean;
  readonly DeleteDelay: number;
}

/** Shared defaults read directly from the rv-ODT schema (E5). */
const properties = rvOdt.$defs.DropDetection.properties;
export const DEFAULT_DROP_DETECTION_CONFIG: DropDetectionConfig = Object.freeze({
  Enabled: properties.Enabled.default,
  GraceTime: properties.GraceTime.default,
  SupportProbeDistance: properties.SupportProbeDistance.default,
  SupportMode: toSupportMode(properties.SupportMode.default),
  SupportRecheckInterval: properties.SupportRecheckInterval.default,
  DeleteUnsupported: properties.DeleteUnsupported.default,
  DeleteDelay: properties.DeleteDelay.default,
});

/** Resolved signal addresses (null = the slot is unwired / bound directly). */
export interface DropDetectionSignals {
  readonly dropActive: string | null;
  readonly dropCount: string | null;
  readonly resetDrops: string | null;
}

/**
 * Narrow slice of {@link RVDropManager} the component talks to — declared here
 * so `ComponentContext` can reference the manager without importing its
 * (heavier) implementation module.
 */
export interface DropDetectionRegistrar {
  /** (Re-)declare `node` as the scene's drop-detection authority. */
  register(node: Object3D, config: DropDetectionConfig, signals: DropDetectionSignals): void;
  /** Drop `node` (component disposed / model changed). */
  unregister(node: Object3D): void;
  /**
   * Receive the latched state on every change, so the AUTHORED component can
   * publish it into its own two feedback slots (and into the PLC addresses the
   * user wired them to). Optional so the narrow test fakes stay valid.
   */
  setFeedbackSink?(sink: ((active: boolean, count: number) => void) | null): void;
  /** Clear every report — the component's `SignalResetDrops` edge. */
  reset?(): void;
}

// ─── Field bounds ────────────────────────────────────────────────────────

/**
 * Clamp at the INPUT, not as a silent runtime surprise: a `GraceTime` of -3 or
 * a `SupportRecheckInterval` of 0 would otherwise turn into a ray storm or a
 * detector that reports on the first tick of every handover. The limits are the
 * ones the schema declares (`minimum`/`maximum`), repeated here because a
 * live inspector edit and an authored `rv_extras` both come through this class
 * and neither is validated against the schema on the way in.
 */
function clamp(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A signal ComponentReference resolves to an ADDRESS string; anything else
 *  (unresolved reference, leftover object) means "not wired". */
function signalAddress(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ─── Component ───────────────────────────────────────────────────────────

/** The `DropDetection` component. Pure configuration — no per-frame work. */
export class RVDropDetection implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json). The enum
  // field needs the identity map `loadSchemaFromSpec` builds — an inline
  // `{ type: 'enum' }` would silently fall back to the default (see
  // RVCollisionRole for the same note).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('DropDetection');

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated fields. Names are the inspector field names.
  Enabled = DEFAULT_DROP_DETECTION_CONFIG.Enabled;
  GraceTime = DEFAULT_DROP_DETECTION_CONFIG.GraceTime;
  SupportProbeDistance = DEFAULT_DROP_DETECTION_CONFIG.SupportProbeDistance;
  SupportMode = DEFAULT_DROP_DETECTION_CONFIG.SupportMode;
  SupportRecheckInterval = DEFAULT_DROP_DETECTION_CONFIG.SupportRecheckInterval;
  DeleteUnsupported = DEFAULT_DROP_DETECTION_CONFIG.DeleteUnsupported;
  DeleteDelay = DEFAULT_DROP_DETECTION_CONFIG.DeleteDelay;
  /** Signal slots — `ComponentReference` is mandatory for a signal field, or
   *  the inspector's drag slot does not bind (project rule, plan-246). */
  SignalDropActive: unknown = null;
  SignalDropCount: unknown = null;
  SignalResetDrops: unknown = null;

  private _registrar: DropDetectionRegistrar | null = null;
  private _writer: SignalWriter | null = null;
  private _unsubs: (() => void)[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  /** The normalized parameter set, bounds applied. */
  get config(): DropDetectionConfig {
    return {
      Enabled: asBool(this.Enabled, DEFAULT_DROP_DETECTION_CONFIG.Enabled),
      GraceTime: clamp(this.GraceTime, 0, 60, DEFAULT_DROP_DETECTION_CONFIG.GraceTime),
      SupportProbeDistance: clamp(this.SupportProbeDistance, 1, 5000, DEFAULT_DROP_DETECTION_CONFIG.SupportProbeDistance),
      SupportMode: toSupportMode(this.SupportMode),
      SupportRecheckInterval: clamp(this.SupportRecheckInterval, 0.05, 10, DEFAULT_DROP_DETECTION_CONFIG.SupportRecheckInterval),
      DeleteUnsupported: asBool(this.DeleteUnsupported, DEFAULT_DROP_DETECTION_CONFIG.DeleteUnsupported),
      DeleteDelay: clamp(this.DeleteDelay, 0, 60, DEFAULT_DROP_DETECTION_CONFIG.DeleteDelay),
    };
  }

  /** The resolved signal addresses. */
  get signals(): DropDetectionSignals {
    return {
      dropActive: signalAddress(this.SignalDropActive),
      dropCount: signalAddress(this.SignalDropCount),
      resetDrops: signalAddress(this.SignalResetDrops),
    };
  }

  private _push(): void {
    this.SupportMode = toSupportMode(this.SupportMode);
    this._registrar?.register(this.node, this.config, this.signals);
  }

  init(ctx: ComponentContext): void {
    this._registrar = ctx.dropManager ?? null;
    this._push();

    // Two feedback slots and one input slot — declared even while UNWIRED, so
    // the inspector can bind them directly (SlotIO, plan-299). The manager also
    // keeps its own `__drop__/…` signals: those are the built-in names every
    // model has, these three are the user's wiring to a real controller.
    slotDeclare(this, 'SignalDropActive', 'feedback', { initial: false });
    slotDeclare(this, 'SignalDropCount', 'feedback', { initial: 0 });
    const activeAddr = signalAddress(this.SignalDropActive);
    const countAddr = signalAddress(this.SignalDropCount);
    if (activeAddr || countAddr) {
      const path = NodeRegistry.computeNodePath(this.node);
      this._writer = createSignalWriter(
        ctx.signalStore, `component:DropDetection:${path}`, 'component', { slotContext: path },
      );
    }
    // `slotWrite` does both halves: the wired PLC address through the writer,
    // and the unwired direct binding through the slot's listeners.
    this._registrar?.setFeedbackSink?.((active, count) => {
      slotWrite(this, 'SignalDropActive', activeAddr, active, this._writer);
      slotWrite(this, 'SignalDropCount', countAddr, count, this._writer);
    });

    // Unwired, the slot is bound directly; a rising edge clears the reports.
    const resetAddr = signalAddress(this.SignalResetDrops);
    const w = wireBoolSignal(ctx.signalStore, resetAddr, (v) => {
      if (v) this._registrar?.reset?.();
    }, `DropDetection "${this.node.name}": SignalResetDrops`, ctx.reapply,
    { instance: this, field: 'SignalResetDrops' });
    this._unsubs.push(w.unsubscribe);
  }

  /** Re-apply after an inspector edit re-wrote the schema fields. */
  reapplyConfig(): void {
    this._push();
  }

  /** Live inspector edit — the manager reads the new value from the next tick. */
  setLiveField(fieldName: string, value: unknown): boolean {
    if (!(fieldName in FIELD_SETTERS)) return false;
    FIELD_SETTERS[fieldName](this, value);
    this._push();
    return true;
  }

  getLiveState(): Record<string, unknown> {
    const c = this.config;
    return {
      Enabled: c.Enabled,
      GraceTime: c.GraceTime,
      SupportProbeDistance: c.SupportProbeDistance,
      SupportMode: c.SupportMode,
      SupportRecheckInterval: c.SupportRecheckInterval,
      DeleteUnsupported: c.DeleteUnsupported,
      DeleteDelay: c.DeleteDelay,
    };
  }

  dispose(): void {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._registrar?.setFeedbackSink?.(null);
    this._registrar?.unregister(this.node);
    this._registrar = null;
    this._writer = null;
    slotUndeclare(this);
  }
}

/** Live-editable fields. A field missing here is not live-editable, instead of
 *  being written through unvalidated. */
const FIELD_SETTERS: Record<string, (c: RVDropDetection, v: unknown) => void> = {
  Enabled: (c, v) => { c.Enabled = asBool(v, true); },
  GraceTime: (c, v) => { c.GraceTime = clamp(v, 0, 60, 0.5); },
  SupportProbeDistance: (c, v) => { c.SupportProbeDistance = clamp(v, 1, 5000, 50); },
  SupportMode: (c, v) => { c.SupportMode = toSupportMode(v); },
  SupportRecheckInterval: (c, v) => { c.SupportRecheckInterval = clamp(v, 0.05, 10, 0.5); },
  DeleteUnsupported: (c, v) => { c.DeleteUnsupported = asBool(v, false); },
  DeleteDelay: (c, v) => { c.DeleteDelay = clamp(v, 0, 60, 1); },
  SignalDropActive: (c, v) => { c.SignalDropActive = v; },
  SignalDropCount: (c, v) => { c.SignalDropCount = v; },
  SignalResetDrops: (c, v) => { c.SignalResetDrops = v; },
};

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'DropDetection',
  displayName: 'Drop Detection',
  schema: RVDropDetection.schema,
  capabilities: {
    authorable: true,        // addable in the asset editor (schema-complete)
    ui: { badge: '#ffa726', filter: 'Drop Detection', category: 'physics' },
  },
  create: (node) => new RVDropDetection(node),
  afterCreate: (inst, node) => setComponentInstance(node, inst),
});
