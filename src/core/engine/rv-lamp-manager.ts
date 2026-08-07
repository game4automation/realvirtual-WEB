// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVLamp } from './rv-lamp';

const DEV_WARNING_THRESHOLD = 50;

/** Viewer-owned fixed-update registry for flashing Lamp components. */
export class LampManager {
  private readonly _lamps = new Set<RVLamp>();
  private readonly _flashing = new Set<RVLamp>();
  private _warnedAboutCount = false;

  get size(): number {
    return this._lamps.size;
  }

  register(lamp: RVLamp): void {
    this._lamps.add(lamp);
    if (
      import.meta.env.DEV
      && !this._warnedAboutCount
      && this._lamps.size > DEV_WARNING_THRESHOLD
    ) {
      this._warnedAboutCount = true;
      console.warn(
        `[LampManager] ${this._lamps.size} lamps are registered; `
        + 'consider limiting active lamps for best performance',
      );
    }
  }

  unregister(lamp: RVLamp): void {
    this._lamps.delete(lamp);
    this._flashing.delete(lamp);
  }

  setFlashing(lamp: RVLamp, flashing: boolean): void {
    this.register(lamp);
    if (flashing) this._flashing.add(lamp);
    else this._flashing.delete(lamp);
  }

  /** Advances every flashing lamp and reports whether any material changed. */
  update(dt: number): boolean {
    let changed = false;
    for (const lamp of this._flashing) {
      if (lamp.updateBlink(dt)) changed = true;
    }
    return changed;
  }

  /** Disposes all registered lamps before their model materials are destroyed. */
  clear(): void {
    while (this._lamps.size > 0) {
      const lamp = this._lamps.values().next().value as RVLamp | undefined;
      if (!lamp) break;
      lamp.dispose();
      this._lamps.delete(lamp);
    }
    this._flashing.clear();
    this._warnedAboutCount = false;
  }
}
