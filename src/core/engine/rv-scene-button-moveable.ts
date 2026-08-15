// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-moveable.ts — browser runtime counterpart of Unity's
 * `SceneButtonMoveable` (plan-417).
 *
 * The cap of a 3D scene button: it translates (or rotates) along a local axis
 * towards an offset target, and carries the lit / unlit state of the button
 * light. It is NEVER a click target of its own — `RVSceneButtonBase` owns the
 * interaction and calls `hover()` / `click()` / `setLight()` here.
 *
 * Coordinate contract. The GLB stores `axis` in Unity coordinates; the schema
 * declares `unityCoords: true`, so the loader hands us the glTF direction
 * (Unity's X negated). For a TRANSLATION that vector is used as is. For a
 * ROTATION the basis change is improper (det = -1), so the equivalent glTF
 * rotation axis is the NEGATED vector at the same angle — see `_rotationAxis`.
 *
 * Material contract (plan-417 §2.8). The demo GLB ships only the *On*
 * materials as glTF materials; the *Off* variants exist solely as Unity
 * descriptor metadata. The light is therefore SYNTHESIZED at runtime: the cap
 * material is cloned once into a lit/unlit pair that differs only in emissive.
 * Equal `baseMaterial` / `activeMaterial` names mean "no light at all" (handle
 * switch, emergency head) — then nothing is cloned and the authored material
 * stays untouched. `dispose()` restores the original material.
 *
 * Batching contract. The cap moves and swaps material at runtime, so its mesh
 * is flagged `userData._rvSceneButtonMesh` — the same three-place exclusion
 * (`rv-batched-render`, `rv-uber-material`, `rv-material-dedup`) that
 * `_rvLampMesh` uses. Only the cap is excluded; the static button base stays
 * batched.
 *
 * Static-freeze contract. `RVLamp` — the component this one was modelled on —
 * only ever swaps a material, so it could ignore the loader's static freeze.
 * The cap MOVES, and that makes the freeze fatal. TWO independent loader passes
 * freeze it, and they sit on OPPOSITE sides of component construction:
 *
 *   1. `processMeshes()` (loader Phase 1) sets `matrixAutoUpdate = false` on
 *      every mesh that is not under a Drive. On such a node writing `position` /
 *      `quaternion` changes nothing, because `matrix` is never recomposed.
 *   2. `freezeStaticMatrices()` (`rv-freeze-static.ts`, loader Phase 11 — AFTER
 *      construction) sets `matrixWorldAutoUpdate = false` on every node the
 *      mover closure does not reach. Three.js still recurses INTO such a node's
 *      children, but it does not compose the node's own `matrixWorld` from
 *      `parent.matrixWorld * matrix`, so a correct `matrix` never gets drawn.
 *
 * Symptom of either half: the signal toggles, the state is correct, the light
 * switches — but the lever never visibly moves.
 *
 * PRIMARY fix for (2) is therefore NOT here but in `rv-freeze-static.ts`:
 * `SceneButtonMoveable` is part of `MOVER_KEY`, so the cap (plus its ancestors
 * and subtree) is never frozen in the first place, whatever the bind order.
 * Undoing it here alone could not work — Phase 11 runs after `init()`.
 *
 * `_bind()` still thaws BOTH flags (belt and braces): it is what handles (1),
 * whose pass runs before construction, and it keeps caps that are placed or
 * re-bound at RUNTIME — after the loader passes are long done — animating.
 * `matrixAutoUpdate = true` is also the same "this node moves" oracle
 * `ensureMovableTransform()` sets for gizmo-moved nodes and `rv-arena-planner`
 * reads. The cap mesh is thawed too when it is a separate child.
 *
 * Only the cap is thawed — deliberately NOT its ancestors. The frozen ancestor
 * chain of a runtime-placed cap is correctly static: `freezeStaticMatrices()`
 * bakes every world matrix before it freezes, so each ancestor `matrixWorld`
 * holds its final value and serves as a fixed parent basis for the cap's own
 * `parent.matrixWorld * matrix`. Thawing them would only give back the
 * per-frame cost the freeze pass exists to save.
 *
 * `dispose()` restores the exact flag values it found, so a torn-down button
 * re-enters the static pipeline unchanged.
 */

import {
  Mesh,
  Quaternion,
  Vector3,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  removeComponentInstance,
  setComponentInstance,
} from './rv-component-registry';
import type { SceneButtonManager } from './rv-scene-button-manager';

/** Below this the animation is snapped onto its target and the tick stops. */
const OFFSET_EPSILON = 1e-6;
const DEG2RAD = Math.PI / 180;

/** Unity material descriptor as serialized into rv_extras (name + provenance). */
interface MaterialDescriptor { name?: string }

/** Browser runtime counterpart of Unity's SceneButtonMoveable component. */
export class RVSceneButtonMoveable implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('SceneButtonMoveable');

  readonly node: Object3D;
  isOwner = true;

  // Schema fields — exact Unity (camelCase) names.
  axis = new Vector3(0, 0, 1);
  moveSpeed = 30;
  hoverOffset = 0.1;
  activeOffset = 0.05;
  mirrorHoverOffset = false;
  angularMovement = false;

  private _manager?: SceneButtonManager;
  private _mesh?: Mesh;
  private _originals?: Material | Material[];
  private _litClones: MeshStandardMaterial[] = [];
  private _unlitClones: MeshStandardMaterial[] = [];
  private _lightCapable = false;
  private _lit = false;
  private _bound = false;
  /** Static-freeze flags `_bind()` thawed, per node, for `dispose()` to restore. */
  private readonly _thawed: {
    node: Object3D;
    matrixAutoUpdate: boolean;
    matrixWorldAutoUpdate: boolean;
  }[] = [];

  private _active = false;
  private _currentOffset = 0;
  private _targetOffset = 0;
  private readonly _initialPosition = new Vector3();
  private readonly _initialRotation = new Quaternion();
  /** Pre-allocated scratch — the tick must not allocate. */
  private readonly _moveAxis = new Vector3(0, 0, 1);
  private readonly _rotationAxis = new Vector3(0, 0, 1);
  private readonly _scratchQuat = new Quaternion();
  private readonly _scratchVec = new Vector3();

  constructor(node: Object3D) {
    this.node = node;
  }

  init(ctx: ComponentContext): void {
    this._manager = ctx.sceneButtonManager;
    this._manager?.register(this);
    this._bind();
  }

  /** True when the cap has a distinct lit material state (base != active). */
  get lightCapable(): boolean {
    return this._lightCapable;
  }

  /** True while the lit material is applied. */
  get isLit(): boolean {
    return this._lit;
  }

  /** Current animated offset (metres, or degrees for angularMovement). */
  get currentOffset(): number {
    return this._currentOffset;
  }

  /** The cap mesh the animation and the light act on (undefined until bound). */
  get capMesh(): Mesh | undefined {
    return this._mesh;
  }

  // ── Unity parity API (called by RVSceneButtonBase) ───────────────

  /** Unity `Hover()` — pointer entered: add the hover offset on top of the state offset. */
  hover(): void {
    this._targetOffset = (this._active ? this.activeOffset : 0)
      + this.hoverOffset * this._mirrorMultiplier();
    this._syncActiveTick();
  }

  /** Unity `Unhover()` — pointer left: fall back to the pure state offset. */
  unhover(): void {
    this.release();
  }

  /** Unity `Click()` — flips the pressed state (the offset target follows on hover/release). */
  click(): void {
    this._active = !this._active;
  }

  /** Unity `Release()` — target = the offset of the current state, no hover bonus. */
  release(): void {
    this._targetOffset = this._active ? this.activeOffset : 0;
    this._syncActiveTick();
  }

  /** Force the pressed state (used when a remote/echoed signal value arrives). */
  setPressed(pressed: boolean): void {
    if (this._active === pressed) return;
    this._active = pressed;
    this.release();
  }

  /** Unity `LightOn()` / `LightOff()`. No-op for a cap without a light. */
  setLight(on: boolean): void {
    if (!this._lightCapable || !this._bound || this._lit === on) return;
    this._lit = on;
    this._applyMaterial();
  }

  // ── Per-frame animation (driven by SceneButtonManager) ───────────

  /** Unity `Update()` — exponential approach, deterministic in dt. */
  updateButton(dt: number): boolean {
    const diff = this._targetOffset - this._currentOffset;
    if (Math.abs(diff) < OFFSET_EPSILON) {
      if (this._currentOffset !== this._targetOffset) {
        this._currentOffset = this._targetOffset;
        this._applyTransform();
        this._manager?.setActive(this, false);
        return true;
      }
      this._manager?.setActive(this, false);
      return false;
    }
    const t = Math.min(1, Math.max(0, dt) * this.moveSpeed);
    this._currentOffset += diff * t;
    this._applyTransform();
    return true;
  }

  // ── Internals ────────────────────────────────────────────────────

  private _mirrorMultiplier(): number {
    return this.mirrorHoverOffset && this._active ? -1 : 1;
  }

  private _syncActiveTick(): void {
    if (Math.abs(this._targetOffset - this._currentOffset) < OFFSET_EPSILON) return;
    this._manager?.setActive(this, true);
  }

  private _applyTransform(): void {
    if (this.angularMovement) {
      this._scratchQuat.setFromAxisAngle(this._rotationAxis, this._currentOffset * DEG2RAD);
      this.node.quaternion.copy(this._initialRotation).multiply(this._scratchQuat);
    } else {
      this._scratchVec.copy(this._moveAxis).multiplyScalar(this._currentOffset);
      this.node.position.copy(this._initialPosition).add(this._scratchVec);
    }
  }

  /**
   * Hand one node back to the dynamic matrix pipeline, remembering the flags so
   * `dispose()` can put it back. See "Static-freeze contract" in the file
   * header: `matrixAutoUpdate` alone is not enough — without
   * `matrixWorldAutoUpdate` the recomposed `matrix` never reaches `matrixWorld`
   * and the cap stays visually frozen. For a GLB load the world flag is already
   * guaranteed by `MOVER_KEY` in `rv-freeze-static.ts`; setting it here covers
   * caps bound after that pass (runtime placement, re-bind).
   */
  private _thaw(node: Object3D): void {
    if (node.matrixAutoUpdate && node.matrixWorldAutoUpdate) return;
    this._thawed.push({
      node,
      matrixAutoUpdate: node.matrixAutoUpdate,
      matrixWorldAutoUpdate: node.matrixWorldAutoUpdate,
    });
    node.matrixAutoUpdate = true;
    node.matrixWorldAutoUpdate = true;
  }

  private _bind(): void {
    if (this._bound) return;
    // Thaw first (see "Static-freeze contract" above): the animated object is
    // `this.node`, and `processMeshes()` has already frozen `matrixAutoUpdate`
    // on it — a cap is never under a Drive. Without this the whole animation
    // below is invisible. (`matrixWorldAutoUpdate` is owned by the freeze pass,
    // which now recognises SceneButtonMoveable as a mover; the write here is the
    // belt-and-braces path for runtime placement.)
    this._thaw(this.node);
    this._initialPosition.copy(this.node.position);
    this._initialRotation.copy(this.node.quaternion);
    this._moveAxis.copy(this.axis);
    if (this._moveAxis.lengthSq() > 0) this._moveAxis.normalize();
    // Improper basis change (Unity LHS → glTF RHS negates X): the equivalent
    // rotation axis is the negated translation axis at the same angle.
    this._rotationAxis.copy(this._moveAxis).negate();

    const mesh = this._findCapMesh();
    if (!mesh) return;
    // A cap authored as an empty parent with the mesh underneath: the child is
    // frozen too, and Three.js will not compose its matrixWorld either.
    if (mesh !== this.node) this._thaw(mesh);
    this._mesh = mesh;
    // Keep the animated, material-swapping cap out of the static batch/uber/
    // dedup pipeline — mirrors the `_rvLampMesh` precedent.
    mesh.userData._rvSceneButtonMesh = true;
    this._bound = true;

    this._lightCapable = this._readLightCapable();
    if (this._lightCapable) this._buildMaterialPair(mesh);
    // Unity parity: the cap starts unlit (SceneButtonMoveable.Awake → LightOff).
    this._lit = false;
    this._applyMaterial();
  }

  /** The cap mesh: the node itself when it is a mesh, else its first real child mesh. */
  private _findCapMesh(): Mesh | undefined {
    if ((this.node as Mesh).isMesh) return this.node as Mesh;
    let result: Mesh | undefined;
    this.node.traverse((candidate) => {
      if (result || !(candidate as Mesh).isMesh) return;
      if (candidate.name.startsWith('_') || candidate.userData?._rvGizmo) return;
      result = candidate as Mesh;
    });
    return result;
  }

  /** base/active material NAMES differ → the button has a light (plan-417 §2.8.2). */
  private _readLightCapable(): boolean {
    const rv = this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    const data = rv?.['SceneButtonMoveable'];
    const base = (data?.['baseMaterial'] as MaterialDescriptor | undefined)?.name;
    const active = (data?.['activeMaterial'] as MaterialDescriptor | undefined)?.name;
    if (!base || !active) return false;
    return base !== active;
  }

  /** One-time lit/unlit clone pair — never per click (plan-417 §2.8.1). */
  private _buildMaterialPair(mesh: Mesh): void {
    const original = mesh.material;
    const materials = Array.isArray(original) ? original : [original];
    const lit: MeshStandardMaterial[] = [];
    const unlit: MeshStandardMaterial[] = [];
    for (const material of materials) {
      const candidate = material as MeshStandardMaterial;
      if (!candidate?.isMeshStandardMaterial) {
        for (const clone of lit) clone.dispose();
        for (const clone of unlit) clone.dispose();
        console.warn(
          `[SceneButtonMoveable] "${this.node.name}" uses ${material?.type ?? 'an unsupported material'}; `
          + 'the button light is unavailable',
        );
        this._lightCapable = false;
        return;
      }
      const litClone = candidate.clone();
      // The authored cap material already carries the "on" emissive in the
      // demo export. Where it does not, light it in its own base color so the
      // state is still visible.
      if (litClone.emissive.getHex() === 0x000000) {
        litClone.emissive.copy(litClone.color);
        litClone.emissiveIntensity = Math.max(1, litClone.emissiveIntensity);
      }
      const unlitClone = candidate.clone();
      unlitClone.emissive.setHex(0x000000);
      unlitClone.emissiveIntensity = 0;
      lit.push(litClone);
      unlit.push(unlitClone);
    }
    this._originals = original;
    this._litClones = lit;
    this._unlitClones = unlit;
  }

  private _applyMaterial(): void {
    const mesh = this._mesh;
    if (!mesh || !this._lightCapable || this._litClones.length === 0) return;
    const clones = this._lit ? this._litClones : this._unlitClones;
    mesh.material = Array.isArray(this._originals) ? clones : clones[0];
  }

  dispose(): void {
    this._manager?.unregister(this);
    this._manager = undefined;
    // Back to the loader's static state — both flags, exactly as found.
    for (let i = this._thawed.length - 1; i >= 0; i--) {
      const entry = this._thawed[i];
      entry.node.matrixAutoUpdate = entry.matrixAutoUpdate;
      entry.node.matrixWorldAutoUpdate = entry.matrixWorldAutoUpdate;
    }
    this._thawed.length = 0;
    if (this._mesh) {
      if (this._originals) this._mesh.material = this._originals;
      if (this._mesh.userData._rvSceneButtonMesh === true) {
        delete this._mesh.userData._rvSceneButtonMesh;
      }
    }
    for (const material of this._litClones) material.dispose();
    for (const material of this._unlitClones) material.dispose();
    this._litClones.length = 0;
    this._unlitClones.length = 0;
    this._mesh = undefined;
    this._originals = undefined;
    this._bound = false;
    this._lit = false;
    this._lightCapable = false;
    removeComponentInstance(this.node, this);
  }
}

registerComponent({
  type: 'SceneButtonMoveable',
  schema: RVSceneButtonMoveable.schema,
  capabilities: {
    // Data + animation only: the cap is deliberately not a hover/click target
    // (a rotated cap would otherwise sit in the pick BVH with a stale pose).
    hoverable: false,
    selectable: false,
    badgeColor: '#8d6e63',
  },
  create: (node) => new RVSceneButtonMoveable(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
