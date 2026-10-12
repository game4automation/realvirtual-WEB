// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Inspector authoring of two field kinds the editor could not edit by hand:
 *
 *  - structural references (a Wait Sensor step's sensor, a Drive To step's
 *    drive, a Set Signal step's signal) — `rv-reference-field.ts` decides which
 *    fields are pickable, what they may point at, and the stored form;
 *  - Unity colours `{r,g,b,a}` (`Lamp.OnColor`) — shown as a colour picker
 *    instead of four number fields, with the runtime's hex mapping and the
 *    alpha kept.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
// Registers the component schemas the helpers read.
import '../src/core/engine/rv-scene-loader';
import {
  referenceTargetOf, pickableReferenceFields, listReferenceCandidates, makeComponentReference, referencePathOf,
  assetRelativePath,
} from '../src/core/hmi/rv-reference-field';
import { isColorValue, colorToHex, hexToColor, inferFieldType } from '../src/core/hmi/rv-inspector-helpers';

function node(name: string, rv?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (rv) n.userData.realvirtual = rv;
  return n;
}

describe('reference fields', () => {
  it('logic-step references get a target from the fallback table', () => {
    expect(referenceTargetOf('LogicStep_WaitForSensor', 'Sensor')).toEqual({ kind: 'component', componentType: 'Sensor' });
    expect(referenceTargetOf('LogicStep_DriveTo', 'drive')).toEqual({ kind: 'component', componentType: 'Drive' });
    expect(referenceTargetOf('LogicStep_SetSignalBool', 'Signal'))
      .toEqual({ kind: 'signal', signalTypes: ['PLCInputBool', 'PLCOutputBool'] });
  });

  it('a schema refType is used where the schema has one', () => {
    expect(referenceTargetOf('Drive_Gear', 'MasterDrive')).toEqual({ kind: 'component', componentType: 'Drive' });
    expect(referenceTargetOf('LogicStep_WaitForZone', 'Zone')).toEqual({ kind: 'component', componentType: 'Zone' });
  });

  it('signal slots, arrays and plain value fields are not pickable references', () => {
    expect(referenceTargetOf('Drive_Simple', 'Forward')).toBeNull();            // signal slot
    expect(referenceTargetOf('LogicStep_WaitForDrivesAtTarget', 'Drives')).toBeNull(); // array
    expect(referenceTargetOf('LogicStep_DriveTo', 'Destination')).toBeNull();   // number
  });

  it('pickableReferenceFields lists the fields of a step', () => {
    expect(pickableReferenceFields('LogicStep_WaitForSensor').map((f) => f.field)).toEqual(['Sensor']);
  });

  /** An asset root `Cell` with the given children; returns [root, registry entries]. */
  function asset(children: Object3D[]): [Object3D, Array<[string, Object3D]>] {
    const root = node('Cell');
    for (const c of children) root.add(c);
    return [root, children.map((c) => [`/${c.name}`, c] as [string, Object3D])];
  }

  it('paths are asset-relative, never the registry path', () => {
    const [root] = asset([]);
    const mount = node('Mount'); const kine = node('Kine');
    root.add(mount); mount.add(kine);
    expect(assetRelativePath(kine, root)).toBe('Mount/Kine');
    expect(assetRelativePath(root, root)).toBeNull();
    expect(assetRelativePath(node('Elsewhere'), root)).toBeNull();
  });

  it('candidates: only matching nodes, owner excluded, sorted by path', () => {
    const step = node('Step', { LogicStep_WaitForSensor: {} });
    const [root, nodes] = asset([
      step, node('SensorB', { Sensor: {} }), node('Belt', { Drive: {} }), node('SensorA', { Sensor: {} }),
    ]);
    const each = (cb: (p: string, n: Object3D) => void) => nodes.forEach(([p, n]) => cb(p, n));
    const list = listReferenceCandidates(each, { kind: 'component', componentType: 'Sensor' }, root, step);
    expect(list.map((c) => c.path)).toEqual(['SensorA', 'SensorB']);
    expect(list[0]).toMatchObject({ componentType: 'Sensor', label: 'SensorA' });
  });

  it('signal candidates name the signal type they carry', () => {
    const signals = node('Signals');
    const [root] = asset([signals]);
    const start = node('Start', { PLCOutputBool: { Name: 'Start' } });
    const speed = node('Speed', { PLCOutputFloat: {} });
    signals.add(start); signals.add(speed);
    const nodes: Array<[string, Object3D]> = [['/Signals/Start', start], ['/Signals/Speed', speed]];
    const each = (cb: (p: string, n: Object3D) => void) => nodes.forEach(([p, n]) => cb(p, n));
    const list = listReferenceCandidates(each, { kind: 'signal', signalTypes: ['PLCInputBool', 'PLCOutputBool'] }, root);
    expect(list).toEqual([{ path: 'Signals/Start', componentType: 'PLCOutputBool', label: 'Start' }]);
  });

  it('the stored form is an rv-ODT ComponentReference', () => {
    const ref = makeComponentReference({ path: 'Cell/SensorA', componentType: 'Sensor' });
    expect(ref).toEqual({ type: 'ComponentReference', path: 'Cell/SensorA', componentType: 'Sensor' });
    expect(referencePathOf(ref)).toBe('Cell/SensorA');
    expect(referencePathOf(null)).toBe('');
  });
});

describe('colour fields', () => {
  it('recognises a Unity colour, and nothing else', () => {
    expect(isColorValue({ r: 1, g: 0.05, b: 0.05, a: 1 })).toBe(true);
    expect(isColorValue({ r: 1, g: 0, b: 0 })).toBe(true);
    expect(isColorValue({ x: 1, y: 0, z: 0 })).toBe(false);
    expect(isColorValue({ r: 1, g: 0, b: 0, name: 'red' })).toBe(false);
    expect(inferFieldType('OnColor', { r: 1, g: 0.05, b: 0.05, a: 1 })).toBe('color');
  });

  it('hex mapping matches the runtime (v * 255, rounded)', () => {
    expect(colorToHex({ r: 1, g: 0.05, b: 0.05 })).toBe('#ff0d0d');
  });

  it('a picked hex keeps the alpha of the previous value', () => {
    expect(hexToColor('#ff0000', { a: 0.5 })).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(hexToColor('#00ff00')).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(hexToColor('red')).toBeNull();
  });
});
