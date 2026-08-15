// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-921 — Path authoring through the GENERIC editor pipeline.
 *
 * Paths are authored without a dedicated tool: `Path` is `authorable`, its
 * structured fields (segments/successors/align) are generic `'json'` schema
 * fields, and `RVPathComponent.reapplyConfig()` re-derives the network/zone
 * registration after a field edit (the same `reapplySchemaForComponent` →
 * `reapplyConfig` path every other component uses).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { RVPathComponent } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import {
  loadSchemaFromSpec,
  getSchemaDefaults,
  getCapabilities,
  applySchema,
} from '../../src/core/engine/rv-component-registry';

const LINE_5M = { kind: 'line', from: [0, 0, 0], to: [0, 0, 5] };
const LINE_10M = { kind: 'line', from: [0, 0, 5], to: [0, 0, 15] };

/** Node carrying an authored rv_extras.Path (the shape the editor stamps). */
function pathNode(name: string, fields: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = { Path: fields };
  return node;
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
});

describe('Path — generic authorability (plan-921)', () => {
  it('Path is authorable with a complete schema (segments/successors/align as json fields)', () => {
    expect(getCapabilities('Path').authorable).toBe(true);
    const schema = loadSchemaFromSpec('Path');
    expect(schema.segments).toEqual({ type: 'json', default: [] });
    expect(schema.successors).toEqual({ type: 'json', default: [] });
    expect(schema.align).toEqual({ type: 'json', default: [0, 1, 0] });
    expect(schema.id).toEqual({ type: 'string' });
    expect(schema.zone).toEqual({ type: 'string' });
    expect(schema.zoneCapacity).toEqual({ type: 'number' });
  });

  it('getSchemaDefaults(Path) deep-copies json defaults (no shared mutable reference)', () => {
    const a = getSchemaDefaults('Path');
    (a.segments as unknown[]).push(LINE_5M);
    const b = getSchemaDefaults('Path');
    expect(b.segments).toEqual([]);
  });

  it('applySchema copies json fields verbatim and detaches them from the extras', () => {
    const instance: Record<string, unknown> = {};
    const extras = { segments: [LINE_5M], successors: ['B'] };
    applySchema(instance, loadSchemaFromSpec('Path'), extras);
    expect(instance.segments).toEqual([LINE_5M]);
    expect(instance.successors).toEqual(['B']);
    // Deep copy: mutating the instance value must not write back into extras.
    (instance.segments as unknown[]).length = 0;
    expect(extras.segments).toEqual([LINE_5M]);
  });

  it('a freshly added Path (schema defaults only) initializes without throwing and registers with length 0', () => {
    const node = pathNode('NewPath', getSchemaDefaults('Path'));
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    expect(comp.path).not.toBeNull();
    expect(comp.path!.length).toBe(0);
    expect(getDefaultPathNetwork().get('NewPath')).toBe(comp.path);
  });
});

describe('Path — reapplyConfig() after a field edit', () => {
  it('segment edits re-derive geometry live', () => {
    const node = pathNode('Route', { segments: [LINE_5M] });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    expect(comp.path!.length).toBeCloseTo(5, 10);

    // The editor writes into userData.realvirtual.Path, then reapplies.
    (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.segments = [LINE_5M, LINE_10M];
    comp.reapplyConfig();

    expect(comp.path!.length).toBeCloseTo(15, 10);
    expect(getDefaultPathNetwork().get('Route')).toBe(comp.path);
  });

  it('an id change swaps the network registration (old id gone, new id live)', () => {
    const node = pathNode('NodeName', { segments: [LINE_5M] });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    expect(getDefaultPathNetwork().get('NodeName')).not.toBeNull();

    (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.id = 'RenamedRoute';
    comp.reapplyConfig();

    expect(getDefaultPathNetwork().get('NodeName')).toBeNull();
    expect(getDefaultPathNetwork().get('RenamedRoute')).toBe(comp.path);
  });

  it('successor edits re-link the graph after resolveGraph()', () => {
    const a = new RVPathComponent(pathNode('A', { segments: [LINE_5M] }));
    const b = new RVPathComponent(pathNode('B', { segments: [LINE_10M] }));
    a.init({} as never);
    b.init({} as never);
    getDefaultPathNetwork().resolveGraph();
    expect(a.path!.successors).toEqual([]);

    (a.node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.successors = ['B'];
    a.reapplyConfig();
    getDefaultPathNetwork().resolveGraph();

    expect(a.path!.successors).toEqual([b.path]);
    expect(b.path!.predecessors).toEqual([a.path]);
  });

  it('zone edits redefine the zone registry (add and remove)', () => {
    const node = pathNode('Z', { segments: [LINE_5M] });
    const comp = new RVPathComponent(node);
    comp.init({} as never);

    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    rv.Path.zone = 'crossing';
    rv.Path.zoneCapacity = 2;
    comp.reapplyConfig();
    expect(getDefaultZoneRegistry().capacityOf('crossing')).toBe(2);
    expect(comp.path!.zoneId).toBe('crossing');

    rv.Path.zone = '';
    comp.reapplyConfig();
    expect(comp.path!.zoneId).toBeNull();
  });

  it('an unparsable payload unregisters and stays unregistered until fixed', () => {
    const node = pathNode('Broken', { segments: [LINE_5M] });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    expect(getDefaultPathNetwork().get('Broken')).not.toBeNull();

    // A foreign inner type is "not ours" — parsePathExtras returns null.
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    rv.Path.type = 'SomethingElse';
    comp.reapplyConfig();
    expect(comp.path).toBeNull();
    expect(getDefaultPathNetwork().get('Broken')).toBeNull();

    rv.Path.type = 'Path';
    comp.reapplyConfig();
    expect(comp.path).not.toBeNull();
    expect(getDefaultPathNetwork().get('Broken')).toBe(comp.path);
  });
});
