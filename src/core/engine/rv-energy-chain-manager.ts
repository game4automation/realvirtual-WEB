// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVEnergyChain } from './rv-energy-chain';

const DEV_WARNING_THRESHOLD = 50;

/**
 * The slice of `RVRaycastManager` the chains need. Structural, not imported —
 * `rv-raycast-manager.ts` sits above the engine in the dependency order and an
 * import would close a cycle.
 */
export interface ChainRaycastHost {
  addAuxRaycastTarget(mesh: Object3D, owner: Object3D): void;
  removeAuxRaycastTarget(mesh: Object3D): void;
}

/**
 * Viewer-owned fixed-update registry for EnergyChain components (plan-362).
 *
 * Modelled on {@link LampManager}: the viewer owns the instance, threads it
 * through `ComponentContext` / `RuntimeNodeDeps`, and the components register
 * THEMSELVES. There is no generic per-component tick capability — the
 * `simulationActive` flag documented in doc-extending-webviewer.md does not
 * exist in `ComponentCapabilities` and is read nowhere — so a dedicated
 * manager is the established route.
 */
export class EnergyChainManager {
  private readonly _chains = new Set<RVEnergyChain>();
  private _warnedAboutCount = false;
  private _raycastHost: ChainRaycastHost | null = null;

  get size(): number {
    return this._chains.size;
  }

  /**
   * Wire the viewer's raycast manager once. Chains cannot reach it themselves:
   * a `SkinnedMesh` is excluded from the pick BVH by contract
   * (`rv-raycast-geometry.ts`), so the only way a chain becomes clickable at all
   * is registering its invisible envelope hull as an auxiliary target.
   */
  setRaycastHost(host: ChainRaycastHost | null): void {
    this._raycastHost = host;
    if (!host) return;
    for (const chain of this._chains) {
      const proxy = chain.pickProxy;
      if (proxy) host.addAuxRaycastTarget(proxy, chain.node);
    }
  }

  /** Register a chain's picking hull, resolving hits back to the chain node. */
  registerProxy(proxy: Object3D, owner: Object3D): void {
    this._raycastHost?.addAuxRaycastTarget(proxy, owner);
  }

  /** Drop a picking hull (chain re-rigged or disposed). */
  unregisterProxy(proxy: Object3D): void {
    this._raycastHost?.removeAuxRaycastTarget(proxy);
  }

  register(chain: RVEnergyChain): void {
    this._chains.add(chain);
    if (
      import.meta.env.DEV
      && !this._warnedAboutCount
      && this._chains.size > DEV_WARNING_THRESHOLD
    ) {
      this._warnedAboutCount = true;
      console.warn(
        `[EnergyChainManager] ${this._chains.size} energy chains are registered; `
        + 'consider limiting active chains for best performance',
      );
    }
  }

  unregister(chain: RVEnergyChain): void {
    this._chains.delete(chain);
  }

  /**
   * Advance every registered chain. Returns `true` when at least one chain
   * actually moved its bones.
   *
   * The caller must mark BOTH render- and shadow-dirty on `true`: a chain can
   * be driven by a live PLC signal or an external transform, neither of which
   * touches the drive loop that normally raises the shadow flag
   * (`rv-core-subsystems.ts` sets shadow-dirty only for active positioning
   * drives), so its shadow would otherwise freeze in the rest pose.
   */
  update(dt: number): boolean {
    let changed = false;
    for (const chain of this._chains) {
      if (chain.updatePose(dt)) changed = true;
    }
    return changed;
  }

  /** Disposes all registered chains before the model's geometry is destroyed. */
  clear(): void {
    while (this._chains.size > 0) {
      const chain = this._chains.values().next().value as RVEnergyChain | undefined;
      if (!chain) break;
      chain.dispose();
      this._chains.delete(chain);
    }
    this._warnedAboutCount = false;
    this._raycastHost = null;
  }
}
