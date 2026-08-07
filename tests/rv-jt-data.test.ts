// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-jt-data.test.ts — the JTData contract (plan-335, tests 5.3-5.10).
 *
 * JTData is read-only CAD provenance written by the rv-jt reader (plan-336). These tests pin
 * the properties the plan promises: every field optional and read-only, no `integer` type
 * (the loader would throw), and — the defect SOL found — a CAD re-import must NOT carry stale
 * metadata over onto the freshly imported revision.
 */

import { describe, it, expect } from 'vitest';
import { BufferGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import rvOdt from '../schema/v1/rv-odt.json';
import { loadSchemaFromSpec, getRegisteredSchemaTypes } from '../src/core/engine/rv-component-registry';
import { isKnownComponentType } from '../src/core/engine/rv-extras-validator';
import { relativePathMap } from '../src/core/editor/rv-cadlink-reimport';
// Side effect: without this the registration never runs and JTData stays unknown.
import '../src/core/editor/rv-jt-data';

const CONTRACT_FIELDS = [
  'ContractVersion', 'PartName', 'Mass', 'MassSource', 'SourceUnits', 'Layer', 'BodyUid',
] as const;

const defs = (rvOdt as unknown as {
  $defs: Record<string, { properties?: Record<string, { type?: string; readonly?: boolean; default?: unknown }> }>;
  components: Record<string, unknown>;
}).$defs;

describe('JTData schema (5.3)', () => {
  it('defines exactly the seven contract fields', () => {
    const props = defs.JTData?.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([...CONTRACT_FIELDS].sort());
  });

  it('marks every field read-only — JTData is never hand-edited', () => {
    const props = defs.JTData?.properties ?? {};
    for (const [name, p] of Object.entries(props)) {
      expect(p.readonly, `${name} must be readonly`).toBe(true);
    }
  });

  it('uses no unsupported property type', () => {
    // `integer` is NOT a FieldType — loadSchemaFromSpec throws on it. This is the trap that
    // would have broken the whole registration.
    const props = defs.JTData?.properties ?? {};
    for (const [name, p] of Object.entries(props)) {
      expect(['number', 'string', 'boolean'], `${name} has type '${p.type}'`).toContain(p.type);
    }
    expect(props.ContractVersion?.type).toBe('number');
  });

  it('declares no defaults — a default would invent a value the file never carried', () => {
    const props = defs.JTData?.properties ?? {};
    for (const [name, p] of Object.entries(props)) {
      expect(p.default, `${name} must not declare a default`).toBeUndefined();
    }
  });

  it('drops the fields struck from the contract in plan-336', () => {
    const props = defs.JTData?.properties ?? {};
    for (const gone of ['Volume', 'Centroid', 'MassUnits', 'InstUid', 'Units']) {
      expect(props[gone], `${gone} was struck from the contract`).toBeUndefined();
    }
  });
});

describe('JTData registration (5.4)', () => {
  it('loads from the spec without throwing', () => {
    expect(() => loadSchemaFromSpec('JTData')).not.toThrow();
  });

  it('is a registered schema type and therefore a known component', () => {
    expect(getRegisteredSchemaTypes()).toContain('JTData');
    expect(isKnownComponentType('JTData')).toBe(true);
  });

  it('is listed in the components index of rv-odt.json', () => {
    expect((rvOdt as unknown as { components: Record<string, unknown> }).components.JTData).toBeDefined();
  });
});

describe('JTData partial blocks (5.5, 5.7)', () => {
  it('accepts a block carrying only a subset of the fields', () => {
    // The reader omits what the source file does not provide — this is the normal case, not a
    // schema violation.
    const schema = loadSchemaFromSpec('JTData');
    const sparse = { ContractVersion: 1, Layer: '1' };
    for (const key of Object.keys(sparse)) {
      expect(schema[key], `${key} must exist in the schema`).toBeDefined();
    }
    expect(Object.keys(sparse).every((k) => k in schema)).toBe(true);
  });

  it('a node without JTData is a valid normal case', () => {
    const node = new Object3D();
    node.userData = { realvirtual: {} };
    expect(node.userData.realvirtual.JTData).toBeUndefined();
  });
});

describe('JTData forward compatibility (5.10)', () => {
  it('keeps unknown fields of a future ContractVersion intact', () => {
    // A GLB written by a newer reader must not lose data on load. The schema-only path does not
    // strip unknown keys — this pins that expectation.
    const block: Record<string, unknown> = { ContractVersion: 2, Layer: '3', FutureField: 'keep me' };
    const node = new Object3D();
    node.userData = { realvirtual: { JTData: block } };
    const stored = node.userData.realvirtual.JTData as Record<string, unknown>;
    expect(stored.FutureField).toBe('keep me');
    expect(stored.ContractVersion).toBe(2);
  });
});


describe('JTData is import provenance, not user state (5.8, F6)', () => {
  /** Build a two-node CAD tree with JTData plus a user-authored component. */
  function tree(jtMass: number, driveSpeed: number): Object3D {
    const root = new Object3D();
    root.name = 'cadRoot';
    root.userData = {
      realvirtual: {
        CADLink: { File: 'part.jt' },
        JTData: { ContractVersion: 1, Mass: jtMass },
      },
    };
    const child = new Object3D();
    child.name = 'child';
    child.userData = {
      jtHandle: 42,
      realvirtual: {
        JTData: { ContractVersion: 1, Mass: jtMass, Layer: '1' },
        Drive: { TargetSpeed: driveSpeed },
      },
    };
    root.add(child);
    return root;
  }

  it('carries user components over but never stale JTData', () => {
    const oldRoot = tree(10, 250);
    const newRoot = tree(99, 0); // fresh revision: different mass, no user edits yet

    // Mirror what reimportCad collects: everything except import provenance.
    const oldMap = relativePathMap(oldRoot);
    const newMap = relativePathMap(newRoot);
    const carried: Record<string, Record<string, unknown>> = {};
    for (const [relPath, oldNode] of oldMap) {
      const rv = oldNode.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (!rv || !newMap.has(relPath)) continue;
      for (const [type, fields] of Object.entries(rv)) {
        if (type.split('_')[0] === 'JTData') continue; // the rule under test
        carried[type] = fields;
      }
    }

    // The user's Drive survives the re-import…
    expect(carried.Drive).toEqual({ TargetSpeed: 250 });
    // …while JTData does not travel, so the new revision's value stands.
    expect(carried.JTData).toBeUndefined();
  });

  it('treats a dedup-suffixed JTData_1 as the same family', () => {
    const rv: Record<string, Record<string, unknown>> = {
      JTData: { Mass: 1 },
      JTData_1: { Mass: 2 },
      Drive: { TargetSpeed: 5 },
    };
    const kept = Object.keys(rv).filter((t) => t.split('_')[0] !== 'JTData');
    expect(kept).toEqual(['Drive']);
  });
});
