// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.13 (SOL #7) + §9.4 regression — the scanner-field overlay follows
 * the travel direction, and the body never measures the overlay.
 *
 * A forklift stands on an angled piece. A direction change AT STANDSTILL (speed
 * 0, field lengths unchanged) moves the overlay from the front to the rear,
 * pointing OUTWARD (away from the body along −travel) — the plugin's change
 * check includes direction and body, not only the lengths. After three
 * direction changes the vehicle is re-bound (DES, the mode switch): the measured
 * body is unchanged because the overlay is flagged `AGV_NO_BODY_KEY`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Mesh, Object3D, Vector3 } from 'three';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultMovementAuthority, setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { setOverlayVisible } from '../../src/core/overlay-visibility-store';
import { AgvScannerFieldPlugin } from '../../src/plugins/agv-scanner-field-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindContinuous, bindDes, clearShared, sig } from '../helpers/agv-harness';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

const fakeViewer = { markRenderDirty: () => {} } as unknown as RVViewer;

describe('plan-595 9.13 — overlay at the leading end', () => {
  it('continuous: direction change at standstill moves the field to the rear, pointing outward; body unchanged after three changes', () => {
    const net = getDefaultPathNetwork();
    const add = (id: string, from: number[], to: number[], succ: string[]): void => {
      net.register(parsePathExtras({
        type: 'Path', version: 1, id, closed: false, align: [0, 1, 0],
        segments: [{ kind: 'line', from, to }], successors: succ, zone: `Z${id}`, zoneCapacity: 1,
      }, id)!);
    };
    add('P2', [0, 0, 0], [8, 0, 0], ['P3']);
    add('P3', [8, 0, 0], [12, 0, 3], []);   // angled: travel (0.8, 0, 0.6)
    net.resolveGraph();
    const zones = getDefaultZoneRegistry();
    zones.claim('ZP2', 'ghost');              // the reverse plan stops at once at the P2 entrance
    const host = makeHost();
    const root = makeAgvRoot('F', { PathId: 'P3', StartPosition: 550, TargetSpeed: 1200, AllowReverse: true,
      ReverseSpeed: 300, ScannerFields: true, VehicleLength: 0, VehicleWidth: 0 }, { length: 2.2, width: 1.0, rootOffset: -0.5 });
    const scene = new Object3D();
    scene.add(root);
    setOverlayVisible('safety-fields', true);
    const plugin = new AgvScannerFieldPlugin();
    plugin.init(fakeViewer);
    const h = bindContinuous(root, host);
    const mb = getDefaultMovementAuthority('continuous');
    const step = (n: number): void => { for (let i = 0; i < n; i++) { iterateFixedUpdate(h, TICK); plugin.onRender(); } };
    const travel = new Vector3(0.8, 0, 0.6);
    const body0 = { ...mb.bodyOf('F')! };
    expect(body0.front).toBeCloseTo(0.6, 6);
    expect(body0.rear).toBeCloseTo(1.6, 6);
    /** Field quad centre along travel (m, from the root), its extent along travel, and the lateral offset. */
    const field = (): { centre: number; min: number; max: number; lateral: number } => {
      const g = root.children.find((c) => c.name === '__agvScannerFields')!;
      root.updateWorldMatrix(true, true);
      const fill = g.children[0] as Mesh; // warning fill (a quad)
      const pos = fill.geometry.getAttribute('position');
      const lat = new Vector3().crossVectors(travel, new Vector3(0, 1, 0)).normalize();
      const along: number[] = [];
      const c = new Vector3();
      for (let i = 0; i < pos.count; i++) {
        const p = fill.localToWorld(new Vector3().fromBufferAttribute(pos, i)).sub(root.position);
        along.push(p.dot(travel));
        c.add(p);
      }
      c.divideScalar(pos.count);
      return { centre: c.dot(travel), min: Math.min(...along), max: Math.max(...along), lateral: c.dot(lat) };
    };
    host.signalStore!.set('F.Agv.Run', false);
    step(30);
    expect(mb.speedOf('F', mb.clock.now)).toBe(0);
    const fwd = field();
    const lengths0 = mb.fieldLengths('F', 0)!;
    expect(fwd.min).toBeGreaterThanOrEqual(body0.front - 1e-3);    // starts at the front …
    expect(fwd.centre).toBeGreaterThan(body0.front);              // … and points ahead
    expect(Math.abs(fwd.lateral)).toBeLessThan(1e-3);
    // Direction change at standstill: speed 0 before and after, lengths unchanged.
    expect(mb.setDirection('F', -1, [net.get('P3')!, net.get('P2')!])).toBe(true);
    host.signalStore!.set('F.Agv.Run', true);
    step(30);
    expect(mb.planDirOf('F')).toBe(-1);
    expect(mb.speedOf('F', mb.clock.now)).toBe(0);
    expect(mb.fieldLengths('F', 0)).toEqual(lengths0);
    const rev = field();
    expect(rev.max).toBeLessThanOrEqual(-body0.rear + 1e-3);      // starts at the rear …
    expect(rev.centre).toBeLessThan(-body0.rear);                 // … and points outward (−travel)
    expect(Math.abs(rev.lateral)).toBeLessThan(1e-3);
    expect(rev.max - rev.min).toBeCloseTo(fwd.max - fwd.min, 3);  // same length
    expect(sig(host, 'F', 'Reverse')).toBe(true);
    expect(sig(host, 'F', 'FieldRear')).toBe(true);
    // Two more direction changes (+1, −1), each at standstill.
    zones.release('ZP2', 'ghost');
    host.signalStore!.set('F.Agv.Run', false);
    step(5);
    expect(mb.setDirection('F', 1)).toBe(true);
    host.signalStore!.set('F.Agv.Run', true);
    step(60 * 8);                                                  // drives to the end of P3 and stops
    expect(mb.planDirOf('F')).toBe(1);
    expect(mb.speedOf('F', mb.clock.now)).toBe(0);
    expect(field().centre).toBeGreaterThan(body0.front);
    host.signalStore!.set('F.Agv.Run', false);
    step(5);
    expect(mb.setDirection('F', -1, [net.get('P3')!, net.get('P2')!])).toBe(true);
    host.signalStore!.set('F.Agv.Run', true);
    step(60 * 3);
    expect(mb.planDirOf('F')).toBe(-1);
    expect(field().centre).toBeLessThan(-body0.rear);
    // Mode switch: the SAME root (overlay attached) is configured again — the body must not grow.
    expect(root.children.some((c) => c.name === '__agvScannerFields')).toBe(true);
    const runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    const body1 = getDefaultMovementAuthority('des').bodyOf('F')!;
    expect(body1.front).toBeCloseTo(body0.front, 6);
    expect(body1.rear).toBeCloseTo(body0.rear, 6);
    expect(body1.width).toBeCloseTo(body0.width, 6);
    runner.dispose();
    plugin.dispose();
  }, 120000);
});
