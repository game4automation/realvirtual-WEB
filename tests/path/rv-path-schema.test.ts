// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.6 — rv_extras.Path schema conformance (plan-187 style):
 * TS-SSOT defaults, graph construction from `successors`, defined fallbacks
 * for unknown plane/version (no NaN), old-GLB compatibility (no Path node →
 * nothing happens) and payload-coupled detection (never node-name-coupled).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import {
  parsePathExtras,
  pathFromNode,
  isPathNode,
  PATH_EXTRAS_DEFAULTS,
  PATH_SCHEMA_VERSION,
  RVPathComponent,
} from '../../src/core/engine/rv-path';
import { RVPathNetwork, getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { NODE_KIND_TESTS, hasPathExtras } from '../../src/core/library-component-loader';
import {
  getRegisteredFactories,
  getSchemaDefaults,
  getConsumedFieldsFromSchema,
} from '../../src/core/engine/rv-component-registry';

const LINE_SEG = { kind: 'line', from: [0, 0, 0], to: [0, 0, 5] };

describe('rv_extras.Path — schema defaults (TS-SSOT)', () => {
  it('minimal payload gets the documented defaults: closed:false, successors:[], align:[0,1,0]', () => {
    expect(PATH_EXTRAS_DEFAULTS.closed).toBe(false);
    expect([...PATH_EXTRAS_DEFAULTS.successors]).toEqual([]);
    expect([...PATH_EXTRAS_DEFAULTS.align]).toEqual([0, 1, 0]);
    expect(PATH_EXTRAS_DEFAULTS.version).toBe(PATH_SCHEMA_VERSION);

    const p = parsePathExtras({ type: 'Path', segments: [LINE_SEG] }, 'P1');
    expect(p).not.toBeNull();
    expect(p!.closed).toBe(false);
    expect([...p!.successorIds]).toEqual([]);
    expect(p!.align.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-12);
    expect(p!.length).toBeCloseTo(5, 10);
  });

  it('explicit fields are honoured (closed, successors, align, id)', () => {
    const p = parsePathExtras({
      type: 'Path',
      version: 1,
      id: 'RouteX',
      segments: [LINE_SEG],
      closed: true,
      successors: ['B', 'C'],
      align: [0, 0, 1],
    }, 'fallback');
    expect(p!.id).toBe('RouteX');
    expect(p!.closed).toBe(true);
    expect([...p!.successorIds]).toEqual(['B', 'C']);
    expect(p!.align.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-12);
  });
});

describe('rv_extras.Path — graph from successors', () => {
  it('RVPathNetwork.resolveGraph links successors and fills predecessors', () => {
    const net = new RVPathNetwork();
    const a = parsePathExtras({ type: 'Path', segments: [LINE_SEG], successors: ['B'] }, 'A')!;
    const b = parsePathExtras({ type: 'Path', segments: [LINE_SEG] }, 'B')!;
    net.register(a);
    net.register(b);
    net.resolveGraph();
    expect(a.successors.map((p) => p.id)).toEqual(['B']);
    expect(b.predecessors.map((p) => p.id)).toEqual(['A']);
  });

  it('dangling successor ids are tolerated (no crash, simply unlinked)', () => {
    const net = new RVPathNetwork();
    const a = parsePathExtras({ type: 'Path', segments: [LINE_SEG], successors: ['Ghost'] }, 'A')!;
    net.register(a);
    expect(() => net.resolveGraph()).not.toThrow();
    expect(a.successors).toEqual([]);
    expect(net.candidateIds(a, 1)).toEqual([]);
  });
});

describe('rv_extras.Path — defined fallbacks (defensive parsing, no NaN)', () => {
  it('unknown plane falls back to XZ, positions stay finite', () => {
    const p = parsePathExtras({
      type: 'Path',
      segments: [{ kind: 'arc', center: [0, 0, 0], radius: 1, startAngle: 0, degrees: 90, plane: 'QQ' }],
    }, 'P')!;
    expect(p.length).toBeCloseTo(Math.PI / 2, 10);
    const pos = p.getAbsPosition(p.length);
    expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
    expect(pos.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-9); // XZ fallback
  });

  it('unknown version parses best-effort (warn, not crash, no NaN)', () => {
    const p = parsePathExtras({ type: 'Path', version: 99, segments: [LINE_SEG] }, 'P')!;
    expect(p.length).toBeCloseTo(5, 10);
    expect(Number.isFinite(p.getAbsPosition(2.5).z)).toBe(true);
  });

  it('malformed segments (missing coords, unknown kind, junk entries) never produce NaN', () => {
    const p = parsePathExtras({
      type: 'Path',
      segments: [
        { kind: 'line' },                          // missing from/to → (0,0,0)→(0,0,0)
        { kind: 'arc', center: [1, 0] },           // missing radius/angles → length 0
        { kind: 'spline' },                        // unknown kind → skipped
        null, 42, 'x',                             // junk → skipped
        LINE_SEG,
      ],
    }, 'P')!;
    expect(p.length).toBeCloseTo(5, 10);
    for (const s of [0, 0.5, 2.5, 5]) {
      const pos = p.getAbsPosition(s);
      expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
    }
  });

  it('a zero-vector align falls back to (0,1,0)', () => {
    const p = parsePathExtras({ type: 'Path', segments: [LINE_SEG], align: [0, 0, 0] }, 'P')!;
    expect(p.align.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-12);
  });
});

describe('rv_extras.Path — zone attributes (Phase 2, additive to schema v1)', () => {
  it('defaults: no zone, no declared capacity', () => {
    expect(PATH_EXTRAS_DEFAULTS.zone).toBeNull();
    expect(PATH_EXTRAS_DEFAULTS.zoneCapacity).toBeNull();
    const p = parsePathExtras({ type: 'Path', segments: [LINE_SEG] }, 'P')!;
    expect(p.zoneId).toBeNull();
    expect(p.zoneCapacity).toBeNull();
  });

  it('explicit zone + zoneCapacity are honoured (capacity floored, ≥ 0)', () => {
    const p = parsePathExtras({
      type: 'Path', segments: [LINE_SEG], zone: 'X1', zoneCapacity: 2.7,
    }, 'P')!;
    expect(p.zoneId).toBe('X1');
    expect(p.zoneCapacity).toBe(2);
    const p0 = parsePathExtras({ type: 'Path', segments: [LINE_SEG], zone: 'Z', zoneCapacity: 0 }, 'P')!;
    expect(p0.zoneCapacity).toBe(0); // capacity 0 (never enterable) is a valid declaration
  });

  it('junk zone values fall back defensively (unzoned / undeclared, no NaN)', () => {
    const p = parsePathExtras({
      type: 'Path', segments: [LINE_SEG], zone: '', zoneCapacity: 'many',
    }, 'P')!;
    expect(p.zoneId).toBeNull();
    expect(p.zoneCapacity).toBeNull();
    const p2 = parsePathExtras({ type: 'Path', segments: [LINE_SEG], zone: 42, zoneCapacity: -3 }, 'P')!;
    expect(p2.zoneId).toBeNull();
    expect(p2.zoneCapacity).toBeNull(); // negative capacity is not a declaration
  });
});

describe('detection — payload-coupled, NEVER node-name-coupled (plan-268 §10)', () => {
  it('a node NAMED "Path" without rv_extras.Path is NOT a path node', () => {
    const node = new Object3D();
    node.name = 'Path';
    expect(isPathNode(node)).toBe(false);
    expect(hasPathExtras(node)).toBe(false);
    expect(NODE_KIND_TESTS.path(node)).toBe(false);
    expect(pathFromNode(node)).toBeNull();
  });

  it('any node name with rv_extras.Path IS a path node', () => {
    const node = new Object3D();
    node.name = 'SomeArbitraryRoute_42';
    node.userData.realvirtual = { Path: { type: 'Path', segments: [LINE_SEG] } };
    expect(isPathNode(node)).toBe(true);
    expect(NODE_KIND_TESTS.path(node)).toBe(true);
    const p = pathFromNode(node);
    expect(p).not.toBeNull();
    expect(p!.id).toBe('SomeArbitraryRoute_42'); // node name = fallback id
    expect(pathFromNode(node)).toBe(p);           // cached (parsed once)
  });

  it('a foreign inner type rejects the payload', () => {
    const node = new Object3D();
    node.userData.realvirtual = { Path: { type: 'SomethingElse', segments: [LINE_SEG] } };
    expect(isPathNode(node)).toBe(false);
    expect(pathFromNode(node)).toBeNull();
    expect(parsePathExtras({ type: 'SomethingElse' }, 'X')).toBeNull();
  });

  it('old GLB without any Path node stays intact (nothing detected, nothing thrown)', () => {
    const root = new Object3D();
    const drive = new Object3D();
    drive.name = 'Drive-Lin-Z';
    drive.userData.realvirtual = { Drive: { Direction: 'LinearZ' } };
    root.add(drive);
    let pathNodes = 0;
    root.traverse((n) => { if (NODE_KIND_TESTS.path(n)) pathNodes++; });
    expect(pathNodes).toBe(0);
    expect(pathFromNode(drive)).toBeNull();
    // the foreign extras are untouched
    expect((drive.userData.realvirtual as Record<string, unknown>).Drive).toEqual({ Direction: 'LinearZ' });
  });
});

describe('scene-loader factory registration', () => {
  it("the 'Path' factory is registered with its scalar schema", () => {
    const factory = getRegisteredFactories().get('Path');
    expect(factory).toBeDefined();
    expect(getSchemaDefaults('Path')).toMatchObject({ version: PATH_SCHEMA_VERSION, closed: false });
    const consumed = getConsumedFieldsFromSchema('Path');
    expect(consumed).toContain('version');
    expect(consumed).toContain('closed');
  });

  it('RVPathComponent registers into / unregisters from its network via init/dispose', () => {
    const node = new Object3D();
    node.name = 'RouteA';
    node.userData.realvirtual = { Path: { type: 'Path', segments: [LINE_SEG] } };
    const comp = new RVPathComponent(node);
    // init uses the DEFAULT network — exercise it, then clean up via dispose.
    comp.init({} as never);
    expect(comp.path).not.toBeNull();
    expect(comp.path!.id).toBe('RouteA');
    expect(getDefaultPathNetwork().get('RouteA')).toBe(comp.path);
    comp.dispose();
    expect(comp.path).toBeNull();
    expect(getDefaultPathNetwork().get('RouteA')).toBeNull();
  });
});
