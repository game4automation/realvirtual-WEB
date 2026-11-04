// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  parseDriveName,
  parseTransportName,
  isStructuralTag,
  isSensorName,
  isCarrierName,
  scanLibraryComponent,
  hasLibraryMarker,
} from '../src/core/library-component-loader';
import { applyKinematicsSpec, ensureExtras } from '../src/core/behavior-runtime';
// Side-effect import: registers the Drive schema so synthesised drives can be
// seeded with the full editable default field set (matches runtime, where the
// drive module is always loaded before a GLB is processed).
import '../src/core/engine/rv-drive';

describe('parseDriveName', () => {
  it('Drive-Lin-Y → LinearY', () => { expect(parseDriveName('Drive-Lin-Y')).toBe('LinearY'); });
  it('Drive-Rot-Z → RotationZ', () => { expect(parseDriveName('Drive-Rot-Z')).toBe('RotationZ'); });
  it('rejects malformed', () => {
    expect(parseDriveName('Drive-XX-Y')).toBeNull();
    expect(parseDriveName('Drive-Lin-W')).toBeNull();
    expect(parseDriveName('DriveLinY')).toBeNull();
  });
});

describe('parseTransportName', () => {
  it('Transport-X → +X', () => { expect(parseTransportName('Transport-X')).toBe('+X'); });
  it('Transport-Z → +Z', () => { expect(parseTransportName('Transport-Z')).toBe('+Z'); });
  it('rejects malformed', () => {
    expect(parseTransportName('TransportX')).toBeNull();
    expect(parseTransportName('Transport-W')).toBeNull();
  });
});

describe('isStructuralTag', () => {
  it('DriveMesh + Base are tags', () => {
    expect(isStructuralTag('DriveMesh')).toBe(true);
    expect(isStructuralTag('Base')).toBe(true);
    expect(isStructuralTag('Something')).toBe(false);
  });
});

describe('isSensorName', () => {
  it('matches bare Sensor and Sensor-<id>', () => {
    expect(isSensorName('Sensor')).toBe(true);        // library assets use bare "Sensor"
    expect(isSensorName('Sensor-1')).toBe(true);
    expect(isSensorName('Sensor-Infeed')).toBe(true);
  });
  it('tolerates Unity/exporter duplicate-name suffixes', () => {
    expect(isSensorName('Sensor_(1)')).toBe(true);       // GLB export of "Sensor (1)"
    expect(isSensorName('Sensor (1)')).toBe(true);       // Unity duplicate name
    expect(isSensorName('Sensor(1)')).toBe(true);
    expect(isSensorName('Sensor-Infeed_(2)')).toBe(true); // dashed id + dup suffix
  });
  it('rejects non-sensor names', () => {
    expect(isSensorName('Sensor_Housing')).toBe(false); // underscore word, not a dup suffix
    expect(isSensorName('SensorMount')).toBe(false);    // no separator
    expect(isSensorName('MySensor-1')).toBe(false);     // prefix only
  });
});

describe('three.js dedup suffix `_<digits>` (plan-622)', () => {
  // GLTFLoader.createUniqueName makes node names unique per FILE: the second
  // instance of a library in one GLB carries `Transport-Z_1`, `Sensor_1`, ...
  it('parseTransportName: suffixed name yields the same axis', () => {
    expect(parseTransportName('Transport-Z_1')).toBe(parseTransportName('Transport-Z'));
    expect(parseTransportName('Transport-Z_12')).toBe('+Z');
    expect(parseTransportName('Transport-X_3')).toBe('+X');
  });
  it('parseDriveName: suffixed name yields the same direction', () => {
    expect(parseDriveName('Drive-Lin-Y_2')).toBe('LinearY');
    expect(parseDriveName('Drive-Rot-Z_10')).toBe('RotationZ');
  });
  it('isSensorName / isCarrierName: bare suffixed names match', () => {
    expect(isSensorName('Sensor_1')).toBe(true);
    expect(isSensorName('Sensor-Infeed_1')).toBe(true);
    expect(isCarrierName('Carrier_3')).toBe(true);
    expect(isCarrierName('Carrier-Front_2')).toBe(true);
  });
  it('existing forms keep matching', () => {
    expect(isSensorName('Sensor_(1)')).toBe(true);
    expect(isSensorName('Sensor (1)')).toBe(true);
    expect(isSensorName('Sensor-Infeed')).toBe(true);
    expect(isCarrierName('Carrier')).toBe(true);
    expect(isCarrierName('Carrier_(2)')).toBe(true);
    expect(isCarrierName('Carrier (2)')).toBe(true);
    expect(parseTransportName('Transport-Z')).toBe('+Z');
    expect(parseDriveName('Drive-Lin-Y')).toBe('LinearY');
  });
  it('no wildcard: malformed suffixes stay unrecognised', () => {
    expect(parseTransportName('Transport-Z_')).toBeNull();
    expect(parseTransportName('Transport-Z_a')).toBeNull();
    expect(parseTransportName('Transport-Zfoo')).toBeNull();
    expect(parseTransportName('Transport-Z1')).toBeNull();
    expect(parseDriveName('Drive-Lin-Y1')).toBeNull();
    expect(parseDriveName('Drive-Lin-Y_')).toBeNull();
    expect(isSensorName('Sensorx')).toBe(false);
    expect(isSensorName('Sensor_')).toBe(false);
    expect(isSensorName('Sensor_Housing')).toBe(false);
    expect(isCarrierName('Carrierx')).toBe(false);
    expect(isCarrierName('Carrier_')).toBe(false);
  });
  it('scanLibraryComponent wires a suffixed Transport + Sensor like the plain ones', () => {
    const root = new Object3D(); root.name = 'RollConveyor_1';
    const t = new Object3D(); t.name = 'Transport-Z_1';
    const s = new Object3D(); s.name = 'Sensor_1';
    root.add(t, s);
    const spec = scanLibraryComponent(root);
    expect(spec.transports).toHaveLength(1);
    expect(spec.transports![0]).toMatchObject({ target: t, direction: '+Z' });
    expect(spec.drives).toHaveLength(1);
    expect(spec.drives![0]).toMatchObject({ target: t, direction: 'LinearZ' });
    expect(spec.sensors).toHaveLength(1);
    expect(spec.sensors![0].target).toBe(s);
  });
});

describe('scanLibraryComponent — Sensor-* nodes', () => {
  it('emits a sensor entry for a Sensor-* node (and not for plain names)', () => {
    const root = new Object3D(); root.name = 'Cell';
    const s = new Object3D(); s.name = 'Sensor-Infeed';
    const plain = new Object3D(); plain.name = 'Housing';
    root.add(s, plain);
    const spec = scanLibraryComponent(root);
    expect(spec.sensors).toHaveLength(1);
    expect(spec.sensors![0].target).toBe(s);
    expect(spec.sensors![0].extra).toMatchObject({ AutoRay: true });  // beam from bounding box
    expect(spec.drives).toHaveLength(0);
    expect(spec.transports).toHaveLength(0);
  });
});

function makeChainTransferTree() {
  // Mimics a typical Unity library asset hierarchy.
  const root = new Object3D(); root.name = 'ChainTransfer';
  const base = new Object3D(); base.name = 'Base';
  const driveLinY = new Object3D(); driveLinY.name = 'Drive-Lin-Y';
  const driveMesh = new Object3D(); driveMesh.name = 'DriveMesh';
  const transportX = new Object3D(); transportX.name = 'Transport-X';
  root.add(base);
  root.add(driveLinY);
  driveLinY.add(driveMesh);
  driveLinY.add(transportX);
  return { root, base, driveLinY, driveMesh, transportX };
}

describe('scanLibraryComponent — ChainTransfer mock tree', () => {
  it('emits a drive entry for Drive-Lin-Y', () => {
    const { root, driveLinY } = makeChainTransferTree();
    const spec = scanLibraryComponent(root);
    // Two drives: the named Drive-Lin-Y plus the synthesised LinearX drive
    // co-located with Transport-X (Transport surfaces always get an
    // attached drive — see scanLibraryComponent docstring).
    expect(spec.drives).toHaveLength(2);
    const named = spec.drives!.find(d => d.target === driveLinY);
    expect(named?.direction).toBe('LinearY');
  });

  it('emits a transport AND auto-synthesises a co-located drive for it', () => {
    const { root, transportX } = makeChainTransferTree();
    const spec = scanLibraryComponent(root);
    expect(spec.transports).toHaveLength(1);
    expect(spec.transports![0].target).toBe(transportX);
    expect(spec.transports![0].direction).toBe('+X');
    // The transport doesn't keep an explicit `drive` ref — runtime
    // findInParent('Drive') resolves the co-located synth.
    expect(spec.transports![0].drive).toBeUndefined();

    // Verify the synthesised drive sits on the SAME node as the transport.
    const synthDrive = spec.drives!.find(d => d.target === transportX);
    expect(synthDrive).toBeDefined();
    expect(synthDrive?.direction).toBe('LinearX');
  });

  it('ignores DriveMesh + Base nodes', () => {
    const { root } = makeChainTransferTree();
    const spec = scanLibraryComponent(root);
    expect(spec.drives).toHaveLength(2);          // Drive-Lin-Y + synth on Transport-X
    expect(spec.transports).toHaveLength(1);
  });

  it('produces correct rv_extras when applied', () => {
    const { root, driveLinY, transportX } = makeChainTransferTree();
    const spec = scanLibraryComponent(root);
    applyKinematicsSpec(root, spec);
    expect((driveLinY.userData.realvirtual as { Drive: { Direction: string } }).Drive.Direction).toBe('LinearY');
    const transportExtras = transportX.userData.realvirtual as {
      Drive?: { Direction: string };
      TransportSurface: { TransportDirection: { x: number; y: number; z: number } };
    };
    // Co-located synthesised drive (LinearX) — what powers this transport.
    expect(transportExtras.Drive?.Direction).toBe('LinearX');
    // TransportDirection uses the schema-correct field name + Vector3 shape.
    // The +X axis (glTF) is pre-negated to compensate for the schema's
    // `unityCoords: true` X-flip on the way in.
    expect(transportExtras.TransportSurface.TransportDirection).toEqual({ x: -1, y: 0, z: 0 });
  });
});

describe('scanLibraryComponent — synthesised drive exposes the full editable schema', () => {
  it('seeds editable Drive defaults so a Drive-* node has the same inspector fields as an authored drive', () => {
    const { root, driveLinY } = makeChainTransferTree();
    const spec = scanLibraryComponent(root);
    applyKinematicsSpec(root, spec);
    const d = (driveLinY.userData.realvirtual as { Drive: Record<string, unknown> }).Drive;
    // Direction comes from the name; every other editable field is seeded from
    // the Drive schema defaults so the inspector renders the complete set.
    expect(d.Direction).toBe('LinearY');
    expect(d.TargetSpeed).toBe(100);
    expect(d.Acceleration).toBe(100);
    expect(d.UseAcceleration).toBe(false);
    expect(d.UseLimits).toBe(false);
    expect(d.LowerLimit).toBe(-180);
    expect(d.UpperLimit).toBe(180);
    expect(d.ReverseDirection).toBe(false);
    expect(d.Offset).toBe(0);
    expect(d.StartPosition).toBe(0);
  });
});

describe('scanLibraryComponent — preserves manual rv_extras (deep-merge)', () => {
  it('keeps existing TargetSpeed on Drive node', () => {
    const { root, driveLinY } = makeChainTransferTree();
    ensureExtras(driveLinY).Drive = { Direction: 'LinearY', TargetSpeed: 1234 };
    const spec = scanLibraryComponent(root);
    applyKinematicsSpec(root, spec);
    const d = (driveLinY.userData.realvirtual as { Drive: Record<string, unknown> }).Drive;
    expect(d.TargetSpeed).toBe(1234); // preserved
    expect(d.Direction).toBe('LinearY');
  });
});

describe('scanLibraryComponent — no marker required', () => {
  it('scans a plain tree without WebLibraryComponent marker', () => {
    // Tree has zero markers — scan still finds Drive-Lin-Y and Transport-X.
    // Drives = the named Drive-Lin-Y + the synth on Transport-X = 2.
    const { root } = makeChainTransferTree();
    expect(hasLibraryMarker(root)).toBe(false);
    const spec = scanLibraryComponent(root);
    expect(spec.drives).toHaveLength(2);
    expect(spec.transports).toHaveLength(1);
  });

  it('ignores nodes that do not match the convention', () => {
    const root = new Object3D(); root.name = 'CustomerMachine';
    const a = new Object3D(); a.name = 'Housing';
    const b = new Object3D(); b.name = 'Bracket-XYZ';     // not a Drive- pattern
    const c = new Object3D(); c.name = 'Transport_Belt';   // underscore, not hyphen
    root.add(a, b, c);
    const spec = scanLibraryComponent(root);
    expect(spec.drives).toHaveLength(0);
    expect(spec.transports).toHaveLength(0);
  });
});

describe('hasLibraryMarker', () => {
  it('returns true for WebLibraryComponent marker', () => {
    const n = new Object3D();
    ensureExtras(n).WebLibraryComponent = { TypeId: 'ChainTransfer', Version: '1.0' };
    expect(hasLibraryMarker(n)).toBe(true);
  });

  it('returns false without marker', () => {
    const n = new Object3D();
    expect(hasLibraryMarker(n)).toBe(false);
    ensureExtras(n).Drive = { Direction: 'LinearX' };
    expect(hasLibraryMarker(n)).toBe(false);
  });
});
