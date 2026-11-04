// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.19 — the document id format (`scenes[0].extras.realvirtual.idVersion`).
 *
 *  - none   → a Unity export: migrated on load (the control case);
 *  - `1`    → the format this viewer writes from Phase 3 on: addresses already, NO
 *             migration; an address resolves, a legacy path is an input (legacy read);
 *  - `2`    → written by a newer viewer: read as stored (no migration, refs unchanged)
 *             plus the `id-version-newer` warning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { getProblems, resetProblemsForTests, ID_VERSION_PROBLEM_CODES } from '../src/core/hmi/problems-store';
import { CR, box, node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { ID_VERSION_CURRENT } from '../src/core/engine/rv-decode-identity';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';

const DRIVE = { Direction: 'LinearX', TargetSpeed: 100 };

async function buildVersionedGlb(idVersion: number | undefined): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  if (idVersion !== undefined) scene.userData.realvirtual = { idVersion };
  const axis = node('Axis', { Drive: { ...DRIVE, TargetSpeed: 222 }, NodeId: 'n-axis' });
  axis.add(box('Body', 0.2));
  const slave = node('Slave', {
    Drive: { ...DRIVE },
    Drive_Gear: { MasterDrive: CR('Axis'), GearFactor: 1, Offset: 0 },
    NodeId: 'n-slave',
  });
  scene.add(axis, slave);
  return sceneToGlb(scene);
}

describe('plan-769 9.19 — idVersion', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); });

  async function load(idVersion: number | undefined): Promise<TestViewerHandle> {
    resetProblemsForTests();
    h = await createTestViewer('webgl');
    await h.viewer.loadModel(`v${idVersion ?? 'none'}.glb`, { data: await buildVersionedGlb(idVersion) });
    return h;
  }

  const newer = () => getProblems().filter((p) => p.code === ID_VERSION_PROBLEM_CODES.newer);

  it('the viewer reads format 1', () => {
    expect(ID_VERSION_CURRENT).toBe(1);
  });

  it('no idVersion: a Unity export — migrated on load, no warning', async () => {
    const { viewer } = await load(undefined);
    const identity = viewer.registry!.identityOfOccurrence('')!;
    expect(identity.idVersion).toBeUndefined();
    expect(identity.migrated).toBe(true);
    expect(identity.counts.references).toBeGreaterThan(0);
    expect(newer()).toEqual([]);
  });

  it('idVersion 1: no migration — an address resolves, a legacy path is a path input', async () => {
    const { viewer } = await load(1);
    const reg = viewer.registry!;
    const identity = reg.identityOfOccurrence('')!;
    expect(identity.idVersion).toBe(1);
    expect(identity.migrated).toBe(false);
    expect(identity.counts.references).toBe(0);
    expect(identity.findings).toEqual([]);
    const slave = reg.getNode('Cell/Slave')!;
    const axis = reg.getNode('Cell/Axis')!;
    const byAddress = reg.resolveRef(slave, { address: '#n-axis' });
    expect(byAddress.status === 'resolved' && byAddress.node).toBe(axis);
    expect(byAddress.status === 'resolved' && byAddress.via).toBe('address');
    expect(reg.readStoredRef(slave, 'Axis').status).toBe('legacy');
    expect(newer()).toEqual([]);
  });

  it('idVersion 2: read as stored — no migration, refs unchanged, id-version-newer warning', async () => {
    const { viewer } = await load(2);
    const reg = viewer.registry!;
    const identity = reg.identityOfOccurrence('')!;
    expect(identity.idVersion).toBe(2);
    expect(identity.migrated).toBe(false);
    expect(identity.counts.references).toBe(0);
    const slave = reg.getNode('Cell/Slave')!;
    // The stored reference is exactly what the file holds …
    const gearExtras = (slave.userData.realvirtual as { Drive_Gear: { MasterDrive: unknown } }).Drive_Gear.MasterDrive;
    expect(gearExtras).toEqual(CR('Axis'));
    // … and still binds through the reader's own path lookup (nothing was rewritten).
    const gear = reg.componentOn<RVDrive>(slave, 'Drive')!.driveBehaviors.find((b) => b instanceof RVDriveGear) as RVDriveGear;
    expect(gear.masterDrive?.node).toBe(reg.getNode('Cell/Axis'));
    const warnings = newer();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
    expect(warnings[0]!.detail).toContain('format 2');
  });
});
