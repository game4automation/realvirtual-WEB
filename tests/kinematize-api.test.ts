// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import {
  applyKinematicsSpec,
  resolveNode,
  nodePathFromRoot,
  axisCodeToVector,
  deepMerge,
  ensureExtras,
} from '../src/core/behavior-runtime';

function makeTree() {
  const root = new Object3D(); root.name = 'Root';
  const a = new Object3D(); a.name = 'Axis1';
  const sub = new Object3D(); sub.name = 'Inner';
  const belt = new Object3D(); belt.name = 'Belt_Infeed';
  root.add(a); a.add(sub);
  root.add(belt);
  return { root, a, sub, belt };
}

describe('resolveNode', () => {
  it('resolves by plain name (BFS)', () => {
    const { root, a } = makeTree();
    expect(resolveNode(root, 'Axis1')).toBe(a);
  });

  it('resolves nested name via BFS', () => {
    const { root, sub } = makeTree();
    expect(resolveNode(root, 'Inner')).toBe(sub);
  });

  it('resolves slash-separated path', () => {
    const { root, sub } = makeTree();
    expect(resolveNode(root, 'Axis1/Inner')).toBe(sub);
  });

  it('tolerates leading root segment in path', () => {
    const { root, sub } = makeTree();
    expect(resolveNode(root, 'Root/Axis1/Inner')).toBe(sub);
  });

  it('returns null for unknown name', () => {
    const { root } = makeTree();
    expect(resolveNode(root, 'NoSuchNode')).toBeNull();
  });

  it('accepts Object3D directly', () => {
    const { root, a } = makeTree();
    expect(resolveNode(root, a)).toBe(a);
  });
});

describe('nodePathFromRoot', () => {
  it('returns slash-path excluding root', () => {
    const { root, sub } = makeTree();
    expect(nodePathFromRoot(sub, root)).toBe('Axis1/Inner');
  });
});

describe('axisCodeToVector', () => {
  it('+X → [1,0,0]', () => { expect(axisCodeToVector('+X')).toEqual([1, 0, 0]); });
  it('-Z → [0,0,-1]', () => { expect(axisCodeToVector('-Z')).toEqual([0, 0, -1]); });
  it('+Y → [0,1,0]', () => { expect(axisCodeToVector('+Y')).toEqual([0, 1, 0]); });
});

describe('deepMerge', () => {
  it('preserves existing fields by default', () => {
    const t: Record<string, unknown> = { a: 1, b: 2 };
    deepMerge(t, { a: 99, c: 3 }, false);
    expect(t).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('overwrites when flag is true', () => {
    const t: Record<string, unknown> = { a: 1 };
    deepMerge(t, { a: 99 }, true);
    expect(t).toEqual({ a: 99 });
  });

  it('recurses into nested plain objects', () => {
    const t: Record<string, unknown> = { Drive: { Direction: 'LinearX', TargetSpeed: 100 } };
    deepMerge(t, { Drive: { TargetSpeed: 500, Acceleration: 200 } }, false);
    expect(t).toEqual({ Drive: { Direction: 'LinearX', TargetSpeed: 100, Acceleration: 200 } });
  });
});

describe('applyKinematicsSpec — Drive', () => {
  it('writes Drive on node addressed by name', () => {
    const { root, a } = makeTree();
    applyKinematicsSpec(root, { drives: [{ target: 'Axis1', direction: 'LinearY' }] });
    expect((a.userData.realvirtual as { Drive: { Direction: string } }).Drive.Direction).toBe('LinearY');
  });

  it('resolves by slash-path', () => {
    const { root, sub } = makeTree();
    applyKinematicsSpec(root, { drives: [{ target: 'Axis1/Inner', direction: 'RotationZ' }] });
    expect((sub.userData.realvirtual as { Drive: { Direction: string } }).Drive.Direction).toBe('RotationZ');
  });

  it('merges speed + acceleration into Drive', () => {
    const { root, a } = makeTree();
    applyKinematicsSpec(root, { drives: [{ target: 'Axis1', direction: 'LinearY', speed: 500, acceleration: 2000 }] });
    const d = (a.userData.realvirtual as { Drive: Record<string, unknown> }).Drive;
    expect(d.TargetSpeed).toBe(500);
    expect(d.Acceleration).toBe(2000);
    expect(d.UseAcceleration).toBe(true);
    expect(d.Direction).toBe('LinearY');
  });

  it('preserves existing Drive fields (deep-merge default)', () => {
    const { root, a } = makeTree();
    ensureExtras(a).Drive = { Direction: 'LinearX', TargetSpeed: 999 };
    applyKinematicsSpec(root, { drives: [{ target: 'Axis1', speed: 500 }] });
    const d = (a.userData.realvirtual as { Drive: Record<string, unknown> }).Drive;
    expect(d.Direction).toBe('LinearX');   // not overwritten
    expect(d.TargetSpeed).toBe(999);        // preserved (not in patch)
  });

  it('tune-only (no direction) preserves existing Direction', () => {
    const { root, a } = makeTree();
    ensureExtras(a).Drive = { Direction: 'LinearZ', TargetSpeed: 100 };
    applyKinematicsSpec(root, { drives: [{ target: 'Axis1', speed: 750 }] });
    const d = (a.userData.realvirtual as { Drive: Record<string, unknown> }).Drive;
    expect(d.Direction).toBe('LinearZ');
    expect(d.TargetSpeed).toBe(100); // existing TargetSpeed wins in deep-merge default
  });

  it('overwrites when overwrite=true', () => {
    const { root, a } = makeTree();
    ensureExtras(a).Drive = { Direction: 'LinearX', TargetSpeed: 999 };
    applyKinematicsSpec(root, {
      overwrite: true,
      drives: [{ target: 'Axis1', direction: 'LinearY', speed: 500 }],
    });
    const d = (a.userData.realvirtual as { Drive: Record<string, unknown> }).Drive;
    expect(d.Direction).toBe('LinearY');
    expect(d.TargetSpeed).toBe(500);
  });

  it('warns on missing node in non-strict mode', () => {
    const { root } = makeTree();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = applyKinematicsSpec(root, { drives: [{ target: 'Ghost', direction: 'LinearY' }] });
    expect(warn).toHaveBeenCalled();
    expect(report.warnings.length).toBe(1);
    expect(report.applied.drives).toBe(0);
    warn.mockRestore();
  });

  it('throws on missing node in strict mode', () => {
    const { root } = makeTree();
    expect(() => applyKinematicsSpec(root, {
      strict: true,
      drives: [{ target: 'Ghost', direction: 'LinearY' }],
    })).toThrow();
  });
});

describe('applyKinematicsSpec — Transport', () => {
  // TransportDirection is a Vector3 with `unityCoords: true` on the schema
  // side, so X is negated on read. To compensate we pre-negate X on write,
  // ensuring the consumed value matches the glTF-space axis we asked for.
  it('writes TransportSurface with +X shorthand', () => {
    const { root, belt } = makeTree();
    applyKinematicsSpec(root, { transports: [{ target: 'Belt_Infeed', direction: '+X', speed: 250 }] });
    const ts = (belt.userData.realvirtual as { TransportSurface: Record<string, unknown> }).TransportSurface;
    expect(ts.TransportDirection).toEqual({ x: -1, y: 0, z: 0 });
    expect(ts.TargetSpeed).toBe(250);
  });

  it('writes TransportSurface with -Z shorthand', () => {
    const { root, belt } = makeTree();
    applyKinematicsSpec(root, { transports: [{ target: 'Belt_Infeed', direction: '-Z' }] });
    const ts = (belt.userData.realvirtual as { TransportSurface: Record<string, unknown> }).TransportSurface;
    expect(ts.TransportDirection).toEqual({ x: -0, y: 0, z: -1 });
  });

  it('does not write an explicit DriveRef — runtime findInParent resolves it', () => {
    // Plan-188 used to write a DriveRef field, but RVTransportSurface
    // resolves its drive at init() via findInParent. The cleaner contract
    // is to omit the field and rely on the registry walk.
    const { root, belt } = makeTree();
    applyKinematicsSpec(root, {
      drives: [{ target: 'Axis1', direction: 'LinearY' }],
      transports: [{ target: 'Belt_Infeed', direction: '+X', drive: 'Axis1' }],
    });
    const ts = (belt.userData.realvirtual as { TransportSurface: Record<string, unknown> }).TransportSurface;
    expect('DriveRef' in ts).toBe(false);
    expect('DriveReference' in ts).toBe(false);
  });
});

describe('applyKinematicsSpec — Sensor + Snap + AAS', () => {
  it('writes Sensor with size', () => {
    const { root, belt } = makeTree();
    applyKinematicsSpec(root, { sensors: [{ target: 'Belt_Infeed', size: [50, 200, 50] }] });
    const s = (belt.userData.realvirtual as { Sensor: { Size: number[] } }).Sensor;
    expect(s.Size).toEqual([50, 200, 50]);
  });

  it('writes Snap with direction + typeId', () => {
    const { root, belt } = makeTree();
    applyKinematicsSpec(root, { snaps: [{ target: 'Belt_Infeed', direction: 'XN', typeId: 'belt' }] });
    const s = (belt.userData.realvirtual as { Snap: Record<string, unknown> }).Snap;
    expect(s.Direction).toBe('XN');
    expect(s.TypeId).toBe('belt');
  });

  it('writes AASLink with file + tab', () => {
    const { root, a } = makeTree();
    applyKinematicsSpec(root, { aasLinks: [{ target: 'Axis1', aasxFile: '/aasx/m.aasx', tab: 'Nameplate' }] });
    const aas = (a.userData.realvirtual as { AASLink: Record<string, unknown> }).AASLink;
    expect(aas.AASxFile).toBe('/aasx/m.aasx');
    expect(aas.Tab).toBe('Nameplate');
  });
});

describe('applyKinematicsSpec — Signals', () => {
  it('accumulates signal records on root', () => {
    const { root } = makeTree();
    applyKinematicsSpec(root, {
      signals: [
        { name: 'Axis1.Position', type: 'PLCOutputFloat', drive: 'Axis1', binding: 'CurrentPosition' },
        { name: 'EStop',          type: 'PLCInputBool', initialValue: false },
      ],
    });
    const list = (root.userData.realvirtual as { __BehaviorSignals: Array<Record<string, unknown>> }).__BehaviorSignals;
    expect(list).toHaveLength(2);
    expect(list[0].Name).toBe('Axis1.Position');
    expect(list[0].Type).toBe('PLCOutputFloat');
    expect(list[0].Drive).toBe('Axis1');
    expect(list[1].Type).toBe('PLCInputBool');
  });
});

describe('editor.kinematize — path lists with commas (rv-path-list)', () => {
  type Resolve = (ctx: unknown, a: Record<string, unknown>) => Record<string, unknown>;
  const ctxOver = (root: Object3D) => ({ viewer: { currentModelRoot: root, registry: null }, selection: [] });

  it('resolveArgs keeps a comma-named part as ONE path (JSON only then; plain names stay plain)', async () => {
    const { editorKinematizeImpl } = await import('../src/plugins/mcp-bridge/rv-mcp-editor-tools');
    const { parsePathList } = await import('../src/core/hmi/rv-path-list');
    const resolve = editorKinematizeImpl.resolveArgs as unknown as Resolve;
    const root = new Object3D(); root.name = 'Asset';
    const r = resolve(ctxOver(root), { paths: '["Asset/LINK,PLATE"]', groupName: 'Axis' });
    expect(r['paths']).toBe('["Asset/LINK,PLATE"]');
    // Replay parses the stored line back to the same single path.
    expect(parsePathList(r['paths'])).toEqual(['Asset/LINK,PLATE']);
    // Legacy comma input still means two paths, stored byte-identical to before.
    const legacy = resolve(ctxOver(root), { paths: 'A,B', groupName: 'Axis' })['paths'];
    expect(legacy).toBe('A\nB');
    expect(parsePathList(legacy)).toEqual(['A', 'B']);
  });

  it('resolveArgs refuses an invalid JSON list instead of splitting it', async () => {
    const { editorKinematizeImpl } = await import('../src/plugins/mcp-bridge/rv-mcp-editor-tools');
    const resolve = editorKinematizeImpl.resolveArgs as unknown as Resolve;
    const root = new Object3D(); root.name = 'Asset';
    expect(() => resolve(ctxOver(root), { paths: '["Asset/LINK,PLATE"', groupName: 'Axis' })).toThrow(/not valid JSON/);
  });
});
