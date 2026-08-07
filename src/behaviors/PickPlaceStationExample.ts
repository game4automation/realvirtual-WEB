// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PickPlaceStation — full behavior example.
 *
 * Demonstrates every concern in a single file:
 *   - Kinematics: drives, transports, sensors, snaps
 *   - PLC signals: typed signal declarations + live read/write
 *   - 60-Hz logic: rv.onFixedUpdate(dt)
 *   - Event reactions: rv.on('sensor:…:enter')
 *   - AAS links: rv.aas(target, file)
 *   - Right-click context menus: rv.contextMenu(target, items)
 *
 * `models[]` matches the GLB **filename** (without `.glb`), supporting
 * exact names, glob patterns, and a bare wildcard `'*'`. Adding more
 * filenames to `models[]` (e.g. customer variants) is the only change
 * needed when the same kinematics applies to multiple GLBs.
 *
 * All subscriptions registered through `rv.*` are auto-disposed when the
 * model is cleared — no cleanup code required.
 */

import { defineBehavior } from '../core/behaviors';

export default defineBehavior({
  models: ['PickPlaceStation', 'PickPlaceStation_*', 'CustomerXY_PnP'],

  bind(rv) {
    // ─── Kinematics ─────────────────────────────────────────────────
    rv.drive('Axis1_LinearSled', 'LinearY',   { speed: 500, acceleration: 2000 });
    rv.drive('Tool_GripperHead', 'RotationZ', { speed: 90 });

    rv.transport('Belt_Infeed_Mesh',  '+X', { speed: 250 });
    rv.transport('Belt_Outfeed_Mesh', '-X', { drive: 'Axis1_LinearSled' });

    rv.sensor('Photoeye_42', { size: [50, 200, 50] });

    rv.snap('Connector_InletEnd',  'XN', 'belt');
    rv.snap('Connector_OutletEnd', 'XP', 'belt');

    // ─── Context menus (right-click on a node) ──────────────────────
    rv.contextMenu('Axis1_LinearSled', [
      { id: 'jog-fwd', label: 'Jog Forward',  action: () => { const d = rv.drives.get('Axis1_LinearSled'); if (d) d.jog(true); } },
      { id: 'jog-bwd', label: 'Jog Backward', action: () => { const d = rv.drives.get('Axis1_LinearSled'); if (d) d.jog(false); } },
      { id: 'home',    label: 'Move to Home', action: () => rv.drives.get('Axis1_LinearSled')?.moveTo(0) },
      { id: 'stop',    label: 'Stop',         action: () => rv.drives.get('Axis1_LinearSled')?.stop(), danger: true, dividerBefore: true },
    ]);

    rv.contextMenu(rv.root, [
      { id: 'estop', label: 'Emergency Stop', action: () => rv.signals.set('Machine.EStop', true), danger: true },
    ], { includeChildren: true });

    // ─── Signals (PLC binding) ──────────────────────────────────────
    rv.signal('Axis1.Position', { type: 'PLCOutputFloat', drive: 'Axis1_LinearSled', binding: 'CurrentPosition' });
    rv.signal('Axis1.Forward',  { type: 'PLCInputBool',   drive: 'Axis1_LinearSled', binding: 'JogForward' });

    // ─── Asset Administration Shell link ────────────────────────────
    rv.aas('Axis1_LinearSled', '/aasx/axis1.aasx', { tab: 'TechnicalData' });

    // ─── 60-Hz logic (auto-disposed on model-cleared) ───────────────
    let cycleTime = 0;
    let photoeyeOccupied = false;
    rv.onFixedUpdate((dt) => {
      cycleTime += dt;
      if (photoeyeOccupied && cycleTime > 0.5) {
        rv.drives.get('Axis1_LinearSled')?.moveTo(250);
        cycleTime = 0;
      }
    });

    // ─── Event reactions (auto-disposed on model-cleared) ───────────
    rv.on('component-event', (...args: unknown[]) => {
      const event = args[0] as {
        componentType?: string;
        kind?: string;
        path?: string;
        payload?: { occupied?: boolean; mu?: unknown };
      } | undefined;
      if (event?.componentType !== 'sensor' || event.kind !== 'changed') return;
      if (event.path !== 'Photoeye_42' && !event.path?.endsWith('/Photoeye_42')) return;
      const wasOccupied = photoeyeOccupied;
      photoeyeOccupied = event.payload?.occupied === true;
      if (photoeyeOccupied && !wasOccupied) {
        // eslint-disable-next-line no-console
        console.log('[PickPlaceStation] workpiece entered:', event.payload?.mu);
      }
    });
    rv.signals.on('Axis1.AtTarget', (v) => {
      if (v) rv.drives.get('Tool_GripperHead')?.jog(true);
    });
  },
});
