// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { RibbonManager } from '../src/core/engine/rv-ribbon-manager';
import { ErrorStore } from '../src/core/engine/rv-error-store';
import type { RVDrive } from '../src/core/engine/rv-drive';
import type { RVRibbonWinder } from '../src/core/engine/rv-ribbon-winder';
import type { RVRibbonDancer } from '../src/core/engine/rv-ribbon-dancer';
import type { RVRibbonPath } from '../src/core/engine/rv-ribbon-path';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

const url = DEV_GLB.ribbonSlitter;
const available = await devAssetAvailable(url);
describe.skipIf(!available)('connected ribbon line stop', () => {
  const errors = new ErrorStore();
  const manager = new RibbonManager(errors);
  let drives: RVDrive[], winders: RVRibbonWinder[], dancers: RVRibbonDancer[], paths: RVRibbonPath[];
  const step = (ticks: number) => { for (let i = 0; i < ticks; i++) {
    for (const drive of drives) drive.update(1 / 60);
    manager.update(1 / 60);
  } };
  beforeAll(async () => {
    const scene = new Scene();
    const result = await loadGLB(url, scene, { preserveHierarchy: true, ribbonManager: manager, errorStore: errors });
    drives = result.registry.getAll<RVDrive>('Drive').map(h => h.instance);
    winders = result.registry.getAll<RVRibbonWinder>('RibbonWinder').map(h => h.instance);
    dancers = result.registry.getAll<RVRibbonDancer>('RibbonDancer').map(h => h.instance);
    paths = result.registry.getAll<RVRibbonPath>('RibbonPath').map(h => h.instance);
  }, 60000);
  beforeEach(() => {
    for (const drive of drives) drive.reset();
    manager.resetAll();
    errors.clear();
    for (const w of winders) w.SpeedControl = w.role === 'unwind' ? 'LineSpeed' : 'Dancer';
    for (const path of paths) path.BreakForceNPer50mm = 35;
    step(10);
  });
  function assertStopped() {
    const positions = drives.map(d => d.currentPosition);
    step(120);
    expect(drives.map(d => d.currentPosition)).toEqual(positions);
    expect(drives.every(d => d.motionBlocked && d.currentSpeed === 0)).toBe(true);
  }
  it('brake failure stops all driven rollers and cannot be bypassed with jog', () => {
    winders.find(w => w.role === 'unwind')!.brakeFault = true;
    step(1);
    expect(errors.getActive().some(e => /brake fault.*Line stopped/.test(e.text))).toBe(true);
    for (const drive of drives) drive.jogForward = true;
    assertStopped();
    winders.forEach(w => { w.brakeFault = false; });
    assertStopped(); // repair alone never restarts a stopped line
    for (const drive of drives) drive.reset();
    manager.resetAll();
    step(10);
    expect(drives.every(d => !d.motionBlocked && d.currentSpeed !== 0)).toBe(true);
    expect(errors.getActive()).toHaveLength(0);
  });
  it('running out of fabric stops the complete line and reports the empty unwinder', () => {
    const unwinder = winders.find(w => w.role === 'unwind')!;
    unwinder.woundLengthMm = 1;
    step(1);
    expect(unwinder.isEmpty).toBe(true);
    expect(errors.getActive().some(e => /unwinder roll empty/.test(e.text))).toBe(true);
    assertStopped();
    expect(paths.every(p => p.sections.every(s => s.speed === 0))).toBe(true);
  });
  it('a jam freezes the carriage but no longer forces load-balanced tension', () => {
    const rewinder = winders.find(w => w.node.name === 'Rewinder_A')!;
    paths.forEach(p => { p.BreakForceNPer50mm = 0; });
    const dancer = dancers.find(d => d.node.name === 'Dancer_A')!;
    dancer.jammed = true;
    const position = dancer.positionMm;
    rewinder.SpeedControl = 'None';
    rewinder.driveOnNode()!.targetSpeed *= 1.2;
    step(120);
    expect(dancer.positionMm).toBe(position);
    const zones = paths.find(p => p.node.name === 'Ribbon_A')!.zones;
    expect(zones.some(z => z.mode === 'integrated' && z.eps > 0.02)).toBe(true);
    expect(errors.getActive().some(e => /overstretched/.test(e.text))).toBe(true);
  });
  it('torn fabric stops every drive of the shared line', () => {
    const rewinder = winders.find(w => w.node.name === 'Rewinder_A')!;
    dancers.forEach(d => { d.jammed = true; });
    rewinder.SpeedControl = 'None';
    rewinder.driveOnNode()!.targetSpeed *= 2;
    step(180);
    expect(paths.some(p => p.zones.some(z => z.broken))).toBe(true);
    expect(errors.getActive().some(e => /torn/.test(e.text))).toBe(true);
    assertStopped();
  });
});
