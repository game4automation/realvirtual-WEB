// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-chain.ts — `Chain` / `ChainElement`, the browser runtime counterpart of
 * Unity's `Chain` + `ChainElement` (plan-733).
 *
 * A chain is N identical elements riding a spline, all driven by ONE `Drive`.
 * Unity defines it; the GLB carries the baked spline sample table plus the
 * configuration; this component rebuilds the elements at load time and poses
 * them every fixed tick from `drive.currentPosition`.
 *
 * ## Three things in here are load-bearing
 *
 * 1. **The elements are BUILT, not loaded.** Unity's `Chain.CreateElements()`
 *    instantiates them at runtime too, so a GLB exported with
 *    `CreateElementeInEditMode` would otherwise deliver a second, stale set.
 *    Children matching the `NameChainElement_<n>` convention are dropped before
 *    cloning (the TEMPLATE itself is never dropped), and the clone count comes
 *    solely from `NumberOfElements`.
 *
 * 2. **Never clone in an authoring load.** The asset editor loads with
 *    `preserveHierarchy` and saves what it sees; cloning there would bake N
 *    copies into the file, and N² on the next round trip. Both halves of the
 *    defence are implemented: no cloning when `ComponentContext.authoring` is
 *    set, AND every clone carries `userData._rvChainElement` so
 *    `pruneRuntimeHelpers()` drops it even if it ever reaches an export.
 *
 * 3. **Cloning follows the `rv-source.ts` MU pattern.** `Object3D.clone()`
 *    JSON-round-trips `userData`, so the clone inherits the template's rv_extras
 *    and would be re-instantiated as a live `ChainElement` by `processExtras`.
 *    The clone's `realvirtual` block is stripped immediately after cloning.
 *
 * The curve mathematics lives in `rv-chain-path.ts`; this file only wires it to
 * the scene graph. Positions and lengths are millimetres (Unity convention)
 * everywhere except the baked sample table, which is metres — the ONE conversion
 * is {@link RVChain._lengthMm}.
 */

import { Object3D, Quaternion, Vector3 } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  removeComponentInstance,
  resolveComponentRefs,
  setComponentInstance,
} from './rv-component-registry';
import { ChainPathTable } from './rv-chain-path';
import type { ChainManager } from './rv-chain-manager';
import type { RVDrive } from './rv-drive';
import { applyShadowFlags } from './rv-mesh-classifier';
// The marker lives in the marker module, not here: the asset exporter's prune
// pass needs it and must not import a component module (see rv-traverse-utils.ts).
import { RV_CHAIN_ELEMENT } from './rv-traverse-utils';

export { RV_CHAIN_ELEMENT };

/** Millimetres per baked sample-table unit (glTF metres). The ONE conversion. */
const MM_PER_UNIT = 1000;

// ── Pre-allocated scratch: the per-tick pose path allocates nothing ──
const _pos = new Vector3();
const _quat = new Quaternion();

/**
 * Per-element configuration, authored on the TEMPLATE node in Unity.
 *
 * It is a registered component so the template's rv_extras are consumed (no
 * dev-mode parity warnings) and editable in the inspector, but it has no
 * behaviour of its own: the owning {@link RVChain} reads these fields and poses
 * every clone. That mirrors Unity, where `Chain` batch-updates its elements and
 * the per-element `Start()` subscription is disabled (`UseBatchUpdate`).
 */
export class RVChainElement implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('ChainElement');

  readonly node: Object3D;
  isOwner = true;

  /** Align the element with the chain tangent while moving. */
  AlignWithChain = true;
  /** Additional up reference for the alignment (unused on the spline path — see
   *  {@link RVChain.updatePose}); kept so the field round-trips. */
  AlignVector: Vector3 = new Vector3(1, 0, 0);
  /** mm — start offset of this element along the chain. */
  InitialPosition = 0;
  /** mm — offset relative to the drive position. */
  OffsetToDrivePosition = 0;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(): void {
    // Nothing to do: the owning Chain drives every element.
  }
}

/** Browser runtime counterpart of Unity's `Chain` component. */
export class RVChain implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Chain');

  readonly node: Object3D;
  isOwner = true;

  // ── Schema fields (PascalCase == C# field names == GLB extras keys) ──
  /** Drive that moves the chain. Wire: `ComponentReference`. */
  ConnectedDrive: unknown = null;
  chainOrientation: 'Horizontal' | 'Vertical' = 'Horizontal';
  NumberOfElements = 0;
  /** mm — position of the FIRST element along the chain. */
  StartPosition = 0;
  CalculatedDeltaPosition = true;
  /** mm — spacing between elements when {@link CalculatedDeltaPosition} is false. */
  DeltaPosition = 0;
  ScaledOnFixedLength = false;
  /** mm — the length the position fraction is scaled over. */
  FixedLength = 1500;
  /** Element template node. Wire: `ComponentReference` (`UnityEngine.Transform`). */
  ChainElement: unknown = null;
  /** Name prefix of the generated elements. */
  NameChainElement = '';
  /** The baked spline block — structured JSON, parsed by `ChainPathTable`. */
  Spline: unknown = null;

  // ── Runtime state ──
  private _table: ChainPathTable | null = null;
  private _drive: RVDrive | null = null;
  private _template: Object3D | null = null;
  private _elements: Object3D[] = [];
  /** mm — the element start offsets, index-parallel to {@link _elements}. */
  private _starts: number[] = [];
  /** mm — the real arc length of the baked curve (the ONE m→mm conversion). */
  private _lengthMm = 0;
  /** mm — per-element offset taken from the template's `ChainElement` extras. */
  private _offsetMm = 0;
  private _alignWithChain = true;
  private _manager: ChainManager | null = null;
  private _lastDrivePos = Number.NaN;
  /** Set when the component could not be made functional (F5). */
  private _inert = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** True when the chain is set up and moving (diagnostics + tests). */
  get isActive(): boolean {
    return !this._inert && this._table !== null;
  }

  /** The runtime element clones, in chain order (diagnostics + tests). */
  get elements(): readonly Object3D[] {
    return this._elements;
  }

  /** mm — the real arc length of the baked curve. */
  get lengthMm(): number {
    return this._lengthMm;
  }

  /** mm — spacing between two consecutive elements. */
  get deltaPositionMm(): number {
    if (!this.CalculatedDeltaPosition) return this.DeltaPosition;
    return this.NumberOfElements > 0 ? this._lengthMm / this.NumberOfElements : 0;
  }

  /** mm — `ScaledOnFixedLength ? FixedLength : Length`, as in Unity. */
  get relevantLengthMm(): number {
    return this.ScaledOnFixedLength ? this.FixedLength : this._lengthMm;
  }

  init(context: ComponentContext): void {
    this._manager = context.chainManager ?? null;
    this._table = ChainPathTable.from(this.Spline);
    if (this._table) this._lengthMm = this._table.lengthM * MM_PER_UNIT;
    // The element build waits for `onSceneReady()`: the Kinematic re-parenting
    // pass (loader Phase 8b) runs between init and onSceneReady, so the template
    // may still move. On paths without an onSceneReady pass
    // (`constructComponentOnNode`) there is nothing left to re-parent and the
    // build happens immediately.
    if (!context.expectSceneReady) this._build(context);
  }

  onSceneReady(context: ComponentContext): void {
    this._build(context);
  }

  // ── Build ──────────────────────────────────────────────────────

  private _build(context: ComponentContext): void {
    if (this._inert || this._elements.length > 0) return;
    resolveComponentRefs(this as unknown as Record<string, unknown>, context.registry);

    if (!this._table) {
      this._goInert('the baked Spline sample table is missing or has fewer than two samples');
      return;
    }

    this._drive = asDrive(this.ConnectedDrive);
    if (!this._drive) {
      // Unity logs an error and keeps running (elements sit at their start
      // pose). Same here: not inert, just never moving.
      console.warn(
        `[Chain] "${this.node.name}" has no resolvable ConnectedDrive — `
        + 'elements are placed at their start positions but will not move.',
      );
    }

    this._template = asTemplateNode(this.ChainElement);
    if (!this._template) {
      this._goInert('the ChainElement template node could not be resolved');
      return;
    }
    if (!this.NameChainElement) this.NameChainElement = this._template.name;

    // Per-element configuration from the template's own rv_extras.
    const elementExtras = extrasOf(this._template, 'ChainElement');
    if (elementExtras) {
      this._alignWithChain = elementExtras['AlignWithChain'] !== false;
      this._offsetMm = numberOr(elementExtras['OffsetToDrivePosition'], 0);
    }

    // Authoring load: the editor saves the tree it sees, so this component must
    // not touch the document at all. Cloning would bake the runtime elements into
    // the file (and N² of them on the next round trip) — and the pruning below
    // would silently DELETE authored nodes from the saved GLB, which is the same
    // class of bug in the other direction. Return before both.
    if (context.authoring) return;

    // Editor-generated elements from a Unity export with
    // `CreateElementeInEditMode = true`. Dropped BEFORE cloning so the chain
    // never ends up with two overlapping sets.
    this._dropAuthoredElements();

    if (!(this.NumberOfElements > 0)) {
      // N == 0 is a legitimate authoring state (chain not configured yet) and
      // Unity's loop simply does nothing. Stay registered so a later reset /
      // inspector edit is not silently dead, but build nothing.
      return;
    }

    this._cloneElements();
    this._manager?.register(this);
    this.reset();
  }

  /**
   * Remove direct children whose name follows Unity's generated-element
   * convention `<NameChainElement>_<n>`, tolerating the glTF `_N` de-dup and the
   * Unity `(N)` duplicate suffix (memory `webviewer-duplicate-node-name-suffixes`).
   * The TEMPLATE is never removed, even when it matches.
   */
  private _dropAuthoredElements(): void {
    const prefix = this.NameChainElement;
    if (!prefix) return;
    const pattern = new RegExp(`^${escapeRegExp(prefix)}_\\d+(?:_\\d+|\\s*\\(\\d+\\))*$`);
    const doomed: Object3D[] = [];
    for (const child of this.node.children) {
      if (child === this._template) continue;
      if (pattern.test(child.name)) doomed.push(child);
    }
    for (const node of doomed) node.removeFromParent();
  }

  /** Clone the template `NumberOfElements` times and compute their start offsets. */
  private _cloneElements(): void {
    const template = this._template!;
    const delta = this.deltaPositionMm;
    for (let i = 0; i < this.NumberOfElements; i++) {
      const clone = template.clone();
      clone.name = `${this.NameChainElement}_${i + 1}`;

      // `Object3D.clone()` JSON-round-trips userData, so the clone inherits the
      // template's rv_extras and would be turned into a live component by a later
      // `processExtras`. Same fix as the MU clone path in rv-source.ts.
      clone.traverse((child) => {
        const ud = child.userData;
        if (!ud) return;
        delete ud.realvirtual;
        delete ud._layoutObject;
        delete ud._layoutId;
      });
      // The runtime marker: `pruneRuntimeHelpers()` drops anything carrying it
      // before an editor save.
      clone.userData[RV_CHAIN_ELEMENT] = true;

      // The template may have been frozen as static geometry by
      // `processMeshes()` (it is not under a Drive). The clone ROOT is the node
      // this component writes every tick, so its local matrix must be rebuilt
      // from position/quaternion. Descendants keep the template's baked matrices.
      clone.matrixAutoUpdate = true;
      clone.matrixWorldAutoUpdate = true;
      clone.visible = true;
      applyShadowFlags(clone);

      this.node.add(clone);
      this._elements.push(clone);
      this._starts.push(this.StartPosition + i * delta);
    }
  }

  private _goInert(reason: string): void {
    this._inert = true;
    console.warn(`[Chain] "${this.node.name}" is inactive: ${reason}.`);
  }

  // ── Tick ───────────────────────────────────────────────────────

  /**
   * Pose every element from the CURRENT drive position. Returns `true` when the
   * poses actually changed — the manager turns that into the render/shadow dirty
   * flags. A chain whose drive has not moved since the last tick costs one float
   * comparison.
   */
  updatePose(): boolean {
    if (this._inert || !this._table || this._elements.length === 0) return false;
    const drivePos = this._drive ? this._drive.currentPosition : 0;
    if (drivePos === this._lastDrivePos) return false;
    this._lastDrivePos = drivePos;
    this._applyPoses(drivePos);
    return true;
  }

  /**
   * Re-pose every element from the drive's CURRENT position. Called by
   * `ChainManager.resetAll()` from `RVViewer.resetSimulation()` — AFTER the
   * `drive.reset()` loop, never from the `simulation-reset` event, which fires
   * before the drives are reset.
   */
  reset(): void {
    if (this._inert || !this._table) return;
    const drivePos = this._drive ? this._drive.currentPosition : 0;
    this._lastDrivePos = drivePos;
    this._applyPoses(drivePos);
  }

  private _applyPoses(drivePos: number): void {
    const table = this._table!;
    const relevant = this.relevantLengthMm;
    const vertical = this.chainOrientation === 'Vertical';
    for (let i = 0; i < this._elements.length; i++) {
      const element = this._elements[i];
      // Unity: `drive.CurrentPosition + element.StartPosition + element.OffsetToDrivePosition`.
      table.poseAt(drivePos + this._starts[i] + this._offsetMm, relevant, vertical, _pos, _quat);
      element.position.copy(_pos);
      if (this._alignWithChain) element.quaternion.copy(_quat);
    }
  }

  // ── Teardown ───────────────────────────────────────────────────

  dispose(): void {
    for (const element of this._elements) element.removeFromParent();
    this._elements = [];
    this._starts = [];
    this._manager?.unregister(this);
    this._manager = null;
    this._table = null;
    this._drive = null;
    this._template = null;
    this._lastDrivePos = Number.NaN;
    removeComponentInstance(this.node, this);
  }
}

// ─── helpers ─────────────────────────────────────────────────────

function asNode(value: unknown): Object3D | null {
  const candidate = value as Object3D | null;
  return candidate && (candidate as unknown as { isObject3D?: boolean }).isObject3D ? candidate : null;
}

/**
 * The template reference resolves to a plain node when the exporter writes the
 * documented `UnityEngine.Transform` wire contract. Unity's field is a
 * `GameObject`, though, and a template carrying `ChainElement` extras also
 * resolves generically to the {@link RVChainElement} instance — accept both and
 * unwrap to the node, so a componentType change on the exporter side cannot
 * silently kill the chain.
 */
function asTemplateNode(value: unknown): Object3D | null {
  const direct = asNode(value);
  if (direct) return direct;
  const owner = (value as { node?: unknown } | null)?.node;
  return asNode(owner);
}

function asDrive(value: unknown): RVDrive | null {
  const candidate = value as RVDrive | null;
  return candidate && typeof (candidate as { currentPosition?: unknown }).currentPosition === 'number'
    ? candidate
    : null;
}

function extrasOf(node: Object3D, key: string): Record<string, unknown> | null {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  const data = rv?.[key];
  return data && typeof data === 'object' ? data as Record<string, unknown> : null;
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

registerComponent({
  type: 'Chain',
  schema: RVChain.schema,
  capabilities: {
    hoverable: true,
    selectable: true,
    filterLabel: 'Chains',
    badgeColor: '#78909c',
  },
  create: (node) => new RVChain(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});

registerComponent({
  type: 'ChainElement',
  schema: RVChainElement.schema,
  capabilities: {
    hoverable: true,
    selectable: true,
    filterLabel: 'Chains',
    badgeColor: '#78909c',
  },
  create: (node) => new RVChainElement(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
