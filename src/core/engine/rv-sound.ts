// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sound.ts — the `Sound` component (plan-2019): makes the Drive on its node
 * audible as an electric motor, a pneumatic cylinder or a hydraulic axis.
 *
 * This module is EAGER and deliberately small: schema, kind/variant resolution,
 * the Problems entries and the registration with the per-page sound hub. The
 * whole audio path (Web Audio context, voice pool, synthesis, the render-frame
 * sampler) lives in `src/core/audio/` and is loaded only when a user switches
 * sound on — nothing from there is imported here (guard: rv-sound-lazy.node.test.ts).
 *
 * The component has only three properties (`Kind`, `Variant`, `Volume`); speed,
 * stroke times and end positions come from the Drive / Drive_Cylinder of the node.
 * The legacy Unity fields `SoundType` / `Mode` are read only when the GLB carried
 * neither `Kind` nor `Variant`.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { loadSchemaFromSpec, registerComponent } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { reportProblem, clearProblem } from '../hmi/problems-store';

/** Authored kind (`Auto` derives Cylinder/Drive from the node). */
export type SoundKind = 'Auto' | 'Drive' | 'Cylinder' | 'Hydraulic';
/** Authored type of the sound. */
export type SoundVariant = 'Auto' | 'Large' | 'Medium' | 'Small' | 'Hard' | 'Cushioned';
/** Kind after resolution. */
export type ResolvedSoundKind = 'Drive' | 'Cylinder' | 'Hydraulic';
/** Variant after resolution (`Auto` only for Hydraulic). */
export type ResolvedSoundVariant = 'Large' | 'Medium' | 'Small' | 'Hard' | 'Cushioned' | 'Auto';
/** Legacy Unity sound clip (`Sound.Soundtype`). */
export type LegacySoundType = 'Robot1' | 'Robot2' | 'SmallElectric1' | 'SmallElectric2' | 'AirPressure';

export const SOUND_TYPE = 'Sound';
export const SOUND_WITHOUT_DRIVE_CODE = 'sound-without-drive';
export const SOUND_VARIANT_MISMATCH_CODE = 'sound-variant-mismatch';

/** The variants a kind accepts (besides `Auto`). */
export const SOUND_VARIANTS_OF_KIND: Readonly<Record<ResolvedSoundKind, readonly SoundVariant[]>> = {
  Drive: ['Large', 'Medium', 'Small'],
  Cylinder: ['Hard', 'Cushioned'],
  Hydraulic: [],
};

/** Inputs of {@link resolveSound} — everything the decision depends on. */
export interface SoundResolveInput {
  kind: SoundKind;
  variant: SoundVariant;
  /** The node carries a `Drive_Cylinder`. */
  hasCylinder: boolean;
  /** `Kind` / `Variant` were present in the GLB (or authored); false = legacy mapping allowed. */
  authoredKind: boolean;
  authoredVariant: boolean;
  soundType?: LegacySoundType | null;
  mode?: string | null;
}

export interface SoundResolution {
  kind: ResolvedSoundKind;
  variant: ResolvedSoundVariant;
  /** The authored variant did not fit the kind and fell back to Auto. */
  mismatch: boolean;
  /** The legacy Unity fields decided the result. */
  legacy: boolean;
}

/** Default variant of a resolved kind. */
export function autoVariantOf(kind: ResolvedSoundKind): ResolvedSoundVariant {
  return kind === 'Drive' ? 'Medium' : kind === 'Cylinder' ? 'Cushioned' : 'Auto';
}

/** Effective kind of an authored kind on a node with/without Drive_Cylinder. */
export function effectiveKindOf(kind: SoundKind, hasCylinder: boolean): ResolvedSoundKind {
  if (kind === 'Drive' || kind === 'Cylinder' || kind === 'Hydraulic') return kind;
  return hasCylinder ? 'Cylinder' : 'Drive';
}

function legacyMapping(t: LegacySoundType | null | undefined): { kind: ResolvedSoundKind; variant: ResolvedSoundVariant } | null {
  switch (t) {
    case 'Robot1': case 'Robot2': return { kind: 'Drive', variant: 'Medium' };
    case 'SmallElectric1': case 'SmallElectric2': return { kind: 'Drive', variant: 'Small' };
    case 'AirPressure': return { kind: 'Cylinder', variant: 'Cushioned' };
    default: return null;
  }
}

/**
 * Resolve kind + variant (plan-2019 §2.3). Pure — the component and the
 * inspector call the same function. `Mode` (`Pick`) is ignored on purpose.
 */
export function resolveSound(input: SoundResolveInput): SoundResolution {
  if (!input.authoredKind && !input.authoredVariant) {
    const legacy = legacyMapping(input.soundType ?? null);
    if (legacy) return { ...legacy, mismatch: false, legacy: true };
  }
  const kind = effectiveKindOf(input.kind, input.hasCylinder);
  const allowed = SOUND_VARIANTS_OF_KIND[kind];
  if (input.variant === 'Auto') return { kind, variant: autoVariantOf(kind), mismatch: false, legacy: false };
  if (allowed.includes(input.variant)) return { kind, variant: input.variant, mismatch: false, legacy: false };
  return { kind, variant: autoVariantOf(kind), mismatch: true, legacy: false };
}

// ─── Drive views (structural, so the audio path needs no engine import) ──

/** What the sampler reads from a drive — position only, plus its configuration. */
export interface SoundDriveLike {
  readonly node: Object3D;
  readonly name: string;
  currentPosition: number;
  /** Configured speed (reference v = 1). */
  TargetSpeed: number;
  /** Runtime speed of the current move. */
  targetSpeed: number;
  /** End of the current positioning move. */
  targetPosition: number;
}

/** End positions of a Drive_Cylinder. */
export interface SoundCylinderLike {
  MinPos: number;
  MaxPos: number;
}

// ─── Sound hub (per page; the SoundSystem plugin filters by scene) ──────

const _sounds = new Set<RVSound>();
const _hubListeners = new Set<() => void>();
let _hubVersion = 0;

function notifyHub(): void {
  _hubVersion++;
  for (const l of _hubListeners) {
    try { l(); } catch (e) { console.error('[Sound] hub listener failed:', e); }
  }
}

/** All registered Sound components of the page (every viewer). */
export function getRegisteredSounds(): ReadonlySet<RVSound> {
  return _sounds;
}

/** Monotonic change counter of the hub (cache token). */
export function getSoundHubVersion(): number {
  return _hubVersion;
}

/** Subscribe to add/remove/re-resolve of Sound components. */
export function subscribeSoundHub(cb: () => void): () => void {
  _hubListeners.add(cb);
  return () => { _hubListeners.delete(cb); };
}

// ─── Component ───────────────────────────────────────────────────────────

/** Browser counterpart of Unity's `Sound` component. */
export class RVSound implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(SOUND_TYPE);

  readonly node: Object3D;
  isOwner = true;

  Kind: SoundKind = 'Auto';
  Variant: SoundVariant = 'Auto';
  Volume = 1;
  SoundType: LegacySoundType | null = null;
  Mode: string | null = null;

  /** `Kind` / `Variant` were present in the loaded extras (set by `beforeSchema`). */
  authoredKind = false;
  authoredVariant = false;

  /** Resolved kind/variant (valid after resolution). */
  kind: ResolvedSoundKind = 'Drive';
  variant: ResolvedSoundVariant = 'Medium';
  /** The Drive on the node; null = inactive (`sound-without-drive`). */
  drive: SoundDriveLike | null = null;
  /** The Drive_Cylinder on the node, when there is one. */
  cylinder: SoundCylinderLike | null = null;
  /** Scene the component belongs to — the SoundSystem of that viewer picks it up. */
  scene: Object3D | null = null;

  private _ctx?: ComponentContext;
  private _path = '';
  private _registered = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** True when the component has a Drive and will sound. */
  get active(): boolean { return this.drive !== null; }

  /** Clamped volume 0..1. */
  get volume(): number {
    const v = Number(this.Volume);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  }

  init(ctx: ComponentContext): void {
    this._ctx = ctx;
    this.scene = ctx.scene ?? null;
    this._path = NodeRegistry.computeNodePath(this.node);
    // Drive and Drive_Cylinder of the node are not guaranteed to exist before
    // this component's init; on load paths that still run onSceneReady the
    // resolution waits for it, on the others (editor add) it runs now.
    if (!ctx.expectSceneReady) this._resolve();
  }

  onSceneReady(ctx: ComponentContext): void {
    this._ctx = ctx;
    if (!this.scene) this.scene = ctx.scene ?? null;
    this._resolve();
  }

  /** An inspector / MCP edit wrote new field values onto the instance. */
  reapplyConfig(): void {
    // A value the editor wrote is authored from now on and beats the legacy fields —
    // an explicit `Auto` too (it is present in the node's Sound extras). A field the
    // editor reset (removed from the extras) is no longer authored; a Volume-only
    // edit keeps the legacy mapping.
    const rv = this.node.userData?.realvirtual as Record<string, unknown> | undefined;
    const extras = rv?.[SOUND_TYPE] as Record<string, unknown> | undefined;
    const present = (key: string): boolean => extras !== undefined && extras[key] !== undefined && extras[key] !== null;
    if (extras) {
      this.authoredKind = present('Kind') || this.Kind !== 'Auto';
      this.authoredVariant = present('Variant') || this.Variant !== 'Auto';
    } else {
      if (this.Kind !== 'Auto') this.authoredKind = true;
      if (this.Variant !== 'Auto') this.authoredVariant = true;
    }
    this._resolve();
  }

  /** Re-run the resolution (also used by tests). */
  resolve(): void { this._resolve(); }

  private _resolve(): void {
    const ctx = this._ctx;
    if (!ctx) return;
    const registry = ctx.registry;
    const drive = registry?.getByPath<SoundDriveLike>('Drive', this._path) ?? null;
    const cylinder = registry?.getByPath<SoundCylinderLike>('Drive_Cylinder', this._path) ?? null;
    const rv = this.node.userData?.realvirtual as Record<string, unknown> | undefined;
    const hasCylinder = cylinder !== null || !!rv?.['Drive_Cylinder'];
    const r = resolveSound({
      kind: this.Kind,
      variant: this.Variant,
      hasCylinder,
      authoredKind: this.authoredKind,
      authoredVariant: this.authoredVariant,
      soundType: this.SoundType,
      mode: this.Mode,
    });
    this.kind = r.kind;
    this.variant = r.variant;
    this.drive = drive;
    this.cylinder = cylinder ?? this._cylinderFromExtras(rv);

    const missingId = `${SOUND_WITHOUT_DRIVE_CODE}:${this._path}`;
    if (!drive) {
      reportProblem({
        id: missingId,
        severity: 'warning',
        code: SOUND_WITHOUT_DRIVE_CODE,
        title: `Sound on "${this.node.name}" has no Drive`,
        detail: 'A Sound component needs a Drive on the same node. Add a Drive or remove the Sound; until then it stays silent.',
        nodePath: this._path,
      });
    } else {
      clearProblem(missingId);
    }
    const mismatchId = `${SOUND_VARIANT_MISMATCH_CODE}:${this._path}`;
    if (r.mismatch) {
      reportProblem({
        id: mismatchId,
        severity: 'warning',
        code: SOUND_VARIANT_MISMATCH_CODE,
        title: `Sound type "${this.Variant}" does not fit "${r.kind}"`,
        detail: `Sound on "${this.node.name}" uses the type "${this.Variant}", which a ${r.kind} sound does not offer. `
          + `It plays as Auto (${autoVariantOf(r.kind)}) — pick one of: Auto, ${SOUND_VARIANTS_OF_KIND[r.kind].join(', ') || 'none'}.`,
        nodePath: this._path,
      });
    } else {
      clearProblem(mismatchId);
    }
    if (!this._registered) {
      this._registered = true;
      _sounds.add(this);
    }
    notifyHub();
  }

  private _cylinderFromExtras(rv: Record<string, unknown> | undefined): SoundCylinderLike | null {
    const c = rv?.['Drive_Cylinder'] as Record<string, unknown> | undefined;
    if (!c) return null;
    const min = Number(c['MinPos'] ?? 0);
    const max = Number(c['MaxPos'] ?? 100);
    return { MinPos: Number.isFinite(min) ? min : 0, MaxPos: Number.isFinite(max) ? max : 100 };
  }

  dispose(): void {
    clearProblem(`${SOUND_WITHOUT_DRIVE_CODE}:${this._path}`);
    clearProblem(`${SOUND_VARIANT_MISMATCH_CODE}:${this._path}`);
    if (this._registered) {
      this._registered = false;
      _sounds.delete(this);
      notifyHub();
    }
    this.drive = null;
    this.cylinder = null;
    this._ctx = undefined;
  }
}

registerComponent({
  type: SOUND_TYPE,
  schema: RVSound.schema,
  capabilities: {
    authorable: true,
    // The Drive on the same node already is the chunk boundary; the Sound adds
    // none (plan-2019 C6) — on a node without Drive it stays inert and costs nothing.
    bake: 'merge',
    ui: { badge: '#26a69a' },
  },
  create: (node) => new RVSound(node),
  beforeSchema: (instance, extras) => {
    const s = instance as RVSound;
    s.authoredKind = extras['Kind'] !== undefined && extras['Kind'] !== null;
    s.authoredVariant = extras['Variant'] !== undefined && extras['Variant'] !== null;
  },
});
