// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  Mesh,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  resolveComponentRefs,
  setComponentInstance,
} from './rv-component-registry';
import { parseColorToHex } from './rv-error-visual';
import { wireValueSignal } from './rv-signal-wiring';
import type { LampManager } from './rv-lamp-manager';

const DEFAULT_ON_COLOR = 0xff0000;

/** Browser runtime counterpart of Unity's Lamp component. */
export class RVLamp implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Lamp');

  readonly node: Object3D;
  isOwner = true;

  SignalLampOn: string | null = null;
  SingalLampFlashing: string | null = null;
  Intensity = 2.0;
  Flashing = false;
  Period = 1.0;
  LampOn = false;

  private _onColorHex = DEFAULT_ON_COLOR;
  private _setLampType = false;
  private _ctx?: ComponentContext;
  private _unsubOn?: () => void;
  private _unsubFlash?: () => void;
  /** True only while `_rebind()` performs the initial signal reads — it applies
   *  the combined LampOn/Flashing state itself afterwards, so the per-slot
   *  writes must stay quiet until then (plan-427 migration). */
  private _wiring = false;
  private _bound = false;
  private _mesh?: Mesh;
  private _originals?: Material | Material[];
  private _clones: MeshStandardMaterial[] = [];
  private _displayedLit = false;
  private _blinkPhase = 0;
  private _lampManager?: LampManager;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(ctx: ComponentContext): void {
    this._ctx = ctx;
    this._tagNode();
    this._rebind();
    this._ensureBound();
  }

  onSceneReady(ctx: ComponentContext): void {
    this._ctx = ctx;
    this._ensureBound();
  }

  reapplyConfig(): void {
    this._rebind();
  }

  private _tagNode(): void {
    this._onColorHex = parseColorToHex(this._readOnColor(), DEFAULT_ON_COLOR);
    if (!this.node.userData._rvType) {
      this.node.userData._rvType = 'Lamp';
      this._setLampType = true;
    }
    Object.defineProperty(this.node.userData, '_rvLamp', {
      value: this,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  private _ensureBound(): void {
    if (this._bound) return;
    const mesh = this._findLampMesh();
    if (!mesh) return;

    const original = mesh.material;
    const materials = Array.isArray(original) ? original : [original];
    const clones: MeshStandardMaterial[] = [];
    for (const material of materials) {
      const candidate = material as MeshStandardMaterial;
      if (!candidate?.isMeshStandardMaterial) {
        for (const clone of clones) clone.dispose();
        console.warn(`[Lamp] "${this.node.name}" uses ${material?.type ?? 'an unsupported material'}; emissive output is unavailable`);
        return;
      }
      clones.push(candidate.clone());
    }

    this._mesh = mesh;
    this._originals = original;
    this._clones = clones;
    mesh.material = Array.isArray(original) ? clones : clones[0];
    mesh.userData._rvLampMesh = true;
    this._bound = true;
    const initialLit = this.Flashing ? true : this.LampOn;
    this._displayedLit = !initialLit;
    this._apply(initialLit);
  }

  private _findLampMesh(): Mesh | undefined {
    let result: Mesh | undefined;
    this.node.traverse((candidate) => {
      if (result || !(candidate as Mesh).isMesh) return;
      if (candidate.name.startsWith('_') || candidate.userData?._rvGizmo) return;
      result = candidate as Mesh;
    });
    return result;
  }

  private _rebind(): void {
    const ctx = this._ctx;
    if (!ctx) return;

    this._unsubOn?.();
    this._unsubOn = undefined;
    this._unsubFlash?.();
    this._unsubFlash = undefined;
    this._lampManager?.unregister(this);
    this._lampManager = undefined;
    this._blinkPhase = 0;

    this._onColorHex = parseColorToHex(this._readOnColor(), DEFAULT_ON_COLOR);
    resolveComponentRefs(this as unknown as Record<string, unknown>, ctx.registry);

    // plan-427: the helpers register a re-apply slot, so a lamp that is lit by a
    // level held across a reset lights up again. Both setters are idempotent
    // (`_displayedLit` guard in `_apply`), so a replay costs nothing. The
    // initial call must NOT drive the optics yet — `_rebind()` applies the
    // combined state itself at the end — hence the `_wiring` gate below.
    this._wiring = true;
    this._unsubOn = wireValueSignal(ctx.signalStore, this.SignalLampOn, (value) => {
      this.LampOn = Boolean(value);
      if (!this._wiring && !this.Flashing) this._apply(this.LampOn);
    }, undefined, ctx.reapply).unsubscribe;
    this._unsubFlash = wireValueSignal(ctx.signalStore, this.SingalLampFlashing, (value) => {
      this.Flashing = Boolean(value);
      if (!this._wiring) this._syncManager();
    }, undefined, ctx.reapply).unsubscribe;
    this._wiring = false;
    this._ensureBound();
    this._syncManager();
    const displayed = this.Flashing ? true : this.LampOn;
    if (this._bound) this._displayedLit = !displayed;
    this._apply(displayed);
  }

  private _syncManager(): void {
    const manager = this._ctx?.lampManager;
    if (manager) {
      if (this._lampManager !== manager) {
        this._lampManager?.unregister(this);
        this._lampManager = manager;
        this._blinkPhase = 0;
        manager.register(this);
      }
      manager.setFlashing(this, this.Flashing);
      this._apply(this.Flashing ? true : this.LampOn);
      return;
    }
    this._lampManager?.unregister(this);
    this._lampManager = undefined;
    this._blinkPhase = 0;
    this._apply(this.Flashing ? true : this.LampOn);
  }

  getOnColorHex(): number {
    return this._onColorHex;
  }

  isLit(): boolean {
    return this._bound ? this._displayedLit : this.LampOn;
  }

  /** Apply one display state without changing the authored/static LampOn value. */
  setDisplayedLit(lit: boolean): boolean {
    return this._apply(lit);
  }

  /** Places the authored material on the matching mesh of an export clone. */
  restoreAuthoredMaterialOn(cloneNode: Object3D): void {
    if (!this._originals) return;
    let cloneMesh: Mesh | undefined;
    cloneNode.traverse((candidate) => {
      if (cloneMesh || !(candidate as Mesh).isMesh) return;
      if (candidate.name.startsWith('_') || candidate.userData?._rvGizmo) return;
      cloneMesh = candidate as Mesh;
    });
    if (cloneMesh) cloneMesh.material = this._originals;
  }

  /** Advances the local symmetric blink phase. Called only by LampManager. */
  updateBlink(dt: number): boolean {
    if (!this.Flashing) return this._apply(this.LampOn);
    if (!Number.isFinite(this.Period) || this.Period <= 0) {
      this._blinkPhase = 0;
      return this._apply(true);
    }
    this._blinkPhase = (this._blinkPhase + Math.max(0, dt)) % this.Period;
    return this._apply(this._blinkPhase < this.Period * 0.5);
  }

  private _apply(lit: boolean): boolean {
    if (!this._bound || this._displayedLit === lit) return false;
    this._displayedLit = lit;
    for (const material of this._clones) {
      material.emissive.setHex(lit ? this._onColorHex : 0x000000);
      material.emissiveIntensity = lit ? Math.max(0, this.Intensity) : 0;
    }
    return true;
  }

  private _readOnColor(): unknown {
    const rv = this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return rv?.['Lamp']?.['OnColor'] ?? null;
  }

  dispose(): void {
    this._unsubOn?.();
    this._unsubOn = undefined;
    this._unsubFlash?.();
    this._unsubFlash = undefined;
    this._lampManager?.unregister(this);
    this._lampManager = undefined;
    this._ctx = undefined;
    if (this._mesh && this._originals) {
      this._mesh.material = this._originals;
      if (this._mesh.userData._rvLampMesh === true) delete this._mesh.userData._rvLampMesh;
    }
    for (const material of this._clones) material.dispose();
    this._clones.length = 0;
    this._mesh = undefined;
    this._originals = undefined;
    this._bound = false;
    this._displayedLit = false;
    this._blinkPhase = 0;
    if (this.node.userData._rvLamp === this) delete this.node.userData._rvLamp;
    if (this._setLampType && this.node.userData._rvType === 'Lamp') delete this.node.userData._rvType;
    this._setLampType = false;
  }
}

registerComponent({
  type: 'Lamp',
  schema: RVLamp.schema,
  capabilities: {
    authorable: true,
    hoverable: true,
    hoverEnabledByDefault: true,
    selectable: true,
    filterLabel: 'Lamps',
    badgeColor: '#ffb300',
    tooltipType: 'lamp',
  },
  create: (node) => new RVLamp(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
