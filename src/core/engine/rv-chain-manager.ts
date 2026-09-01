// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-chain-manager.ts — viewer-owned fixed-update registry for `Chain`
 * components (plan-733).
 *
 * Same shape as {@link EnergyChainManager} and `LampManager`: the viewer owns the
 * instance, threads it through `ComponentContext` / `RuntimeNodeDeps`, and the
 * components register THEMSELVES. There is no generic per-component tick
 * capability in the registry, so a dedicated manager is the established route.
 *
 * Two call sites, and their order is load-bearing:
 *
 * - `CoreSubsystems.visuals()` calls {@link update} AFTER `drives()`, so an
 *   element pose is built from the drive position of THIS tick (no one-tick lag).
 * - `RVViewer.resetSimulation()` calls {@link resetAll} AFTER the
 *   `drive.reset()` loop. It deliberately does NOT listen to `simulation-reset`:
 *   that event is emitted BEFORE the drives are reset, so a chain reacting to it
 *   would re-pose from the pre-reset drive position and stay wrong until the next
 *   movement.
 */

import type { RVChain } from './rv-chain';

/** Dev-only hint that a scene carries an unusual number of chains. */
const DEV_WARNING_THRESHOLD = 50;

export class ChainManager {
  private readonly _chains = new Set<RVChain>();
  private _warnedAboutCount = false;

  get size(): number {
    return this._chains.size;
  }

  register(chain: RVChain): void {
    this._chains.add(chain);
    if (
      import.meta.env.DEV
      && !this._warnedAboutCount
      && this._chains.size > DEV_WARNING_THRESHOLD
    ) {
      this._warnedAboutCount = true;
      console.warn(
        `[ChainManager] ${this._chains.size} chains are registered; `
        + 'consider reducing the number of chain elements for best performance',
      );
    }
  }

  unregister(chain: RVChain): void {
    this._chains.delete(chain);
  }

  /**
   * Advance every registered chain. Returns `true` when at least one chain
   * actually moved its elements.
   *
   * The caller marks render- AND shadow-dirty on `true`. The shadow flag is
   * redundant for the common case — `CoreSubsystems.drives()` already raises it
   * for every running positioning drive — but a chain can also be driven by a
   * `positionOverwrite` from a live signal on a transport-surface drive, which
   * the drive loop skips. Cheap, and it removes a whole class of "the chain
   * moves but its shadow is frozen" reports.
   */
  update(_dt: number): boolean {
    let changed = false;
    for (const chain of this._chains) {
      if (chain.updatePose()) changed = true;
    }
    return changed;
  }

  /**
   * Restore every chain's authored start pose. Called from
   * `RVViewer.resetSimulation()` AFTER the drives were reset (see the file
   * header) — never from the `simulation-reset` event.
   */
  resetAll(): void {
    for (const chain of this._chains) chain.reset();
  }

  /** Dispose every registered chain before the model's geometry is destroyed. */
  clear(): void {
    while (this._chains.size > 0) {
      const chain = this._chains.values().next().value as RVChain | undefined;
      if (!chain) break;
      chain.dispose();
      this._chains.delete(chain);
    }
    this._warnedAboutCount = false;
  }
}
