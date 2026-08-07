// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive } from '../../../core/engine/rv-drive';
import {
  addSignal,
  attachDriveBehaviorByCode,
} from '../../../core/engine/rv-signal-construction';
import { RVBehavior } from '../../../core/rv-behavior';

/** Adds explicitly wired follow-position signals to the demo robot's bare axes. */
export class RobotFollowPositionPlugin extends RVBehavior {
  readonly id = 'robot-follow-position';

  private axes: RVDrive[] = [];

  protected onStart(): void {
    const viewer = this.viewer;
    const playback = this.playback;
    const signalStore = this.signals;
    const registry = viewer?.registry ?? null;
    if (!viewer || !playback || !signalStore || !registry) return;

    for (const drive of playback.boundDrives) {
      if (!drive || this._hasDriveBehavior(drive)) continue;

      const position = addSignal(
        drive.node,
        `${drive.name}.Position`,
        'PLCOutputFloat',
        signalStore,
        registry,
      );
      const currentPosition = addSignal(
        drive.node,
        `${drive.name}.CurrentPosition`,
        'PLCInputFloat',
        signalStore,
        registry,
      );
      attachDriveBehaviorByCode(viewer, drive.node, 'Drive_FollowPosition', {
        Position: position,
        CurrentPosition: currentPosition,
      });
      if (!this.axes.includes(drive)) this.axes.push(drive);
    }
  }

  protected onDestroy(): void {
    this.axes.length = 0;
  }

  private _hasDriveBehavior(drive: RVDrive): boolean {
    const rv = drive.node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return false;
    for (const key of Object.keys(rv)) {
      const base = key.replace(/_\d+$/, '');
      if (base !== 'Drive' && base.startsWith('Drive_')) return true;
    }
    return false;
  }
}
