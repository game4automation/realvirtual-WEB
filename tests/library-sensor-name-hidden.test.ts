// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.10 (D5) — the `Sensor…` name rule skips hidden nodes (a hidden
 * detection body or reflector stand-in is no light barrier). Both forms of
 * "hidden": `visible === false` and the authored `Hidden` flag, which
 * `applyAuthoredHidden` only turns into `visible = false` AFTER the naming scan.
 * Only the Sensor branch: a hidden Transport keeps its components.
 */
import { describe, it, expect } from 'vitest';
import { Group, Object3D } from 'three';
import { scanLibraryComponent } from '../src/core/library-component-loader';

function n(name: string, setup?: (o: Object3D) => void): Object3D {
  const o = new Object3D(); o.name = name; setup?.(o); return o;
}

describe('plan-675 D5 sensor name rule and hidden nodes', () => {
  it('a visible Sensor becomes a sensor; hidden ones (visible=false or Hidden extras) do not', () => {
    const root = new Group();
    root.add(n('Sensor-A'));
    root.add(n('Sensor-B', (o) => { o.visible = false; }));
    root.add(n('Sensor', (o) => { o.userData.realvirtual = { Hidden: true }; }));
    const spec = scanLibraryComponent(root);
    expect(spec.sensors!.map((s) => (s.target as { name: string }).name)).toEqual(['Sensor-A']);
  });

  it('a hidden Transport keeps its Drive and TransportSurface', () => {
    const root = new Group();
    root.add(n('Transport-Z', (o) => { o.visible = false; }));
    const spec = scanLibraryComponent(root);
    expect(spec.transports).toHaveLength(1);
    expect(spec.drives).toHaveLength(1);
  });
});
