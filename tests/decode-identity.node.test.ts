// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 1a — `rv-decode-identity.ts` on a hand-built parse result (exact
 * `json.nodes` control, no loader): the seeded ids go to the RUNTIME key only, an
 * authored id wins and a leaked runtime key never survives, the migration verdicts
 * of the decode pass equal the on-demand answers after the lookup tables were
 * dropped, and the findings name what the Problems panel will show.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  decodeIdentity, getDecodeIdentity, identityIdOf, seededNodeIdOf, stripSeededNodeIds,
} from '../src/core/engine/rv-decode-identity';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { seedNodeIdsForFile } from '../src/core/engine/rv-node-id-seed.mjs';
import { getNodeId } from '../src/core/engine/rv-node-id';

const CR = (path: string) => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });

/** A parse result as GLTFLoader shapes it: objects per node, associations, extras as userData. */
function fakeParse(json: { scene?: number; scenes: Array<Record<string, unknown>>; nodes: Array<Record<string, unknown>> }, loaderNames?: Record<number, string>) {
  const scene = new Object3D();
  scene.name = String(json.scenes[0]!.name ?? '');
  const objs = json.nodes.map((n, i) => {
    const o = new Object3D();
    o.name = loaderNames?.[i] ?? String(n.name ?? '');
    Object.assign(o.userData, (n.extras as Record<string, unknown> | undefined) ?? {});
    return o;
  });
  const attach = (parent: Object3D, list: number[] | undefined) => {
    for (const i of list ?? []) { parent.add(objs[i]!); attach(objs[i]!, json.nodes[i]!.children as number[] | undefined); }
  };
  attach(scene, json.scenes[0]!.nodes as number[]);
  const associations = new Map<Object3D, { nodes?: number }>(objs.map((o, i) => [o, { nodes: i }]));
  return { gltf: { scene, parser: { json, associations } }, objs, scene };
}

function file() {
  return {
    scene: 0,
    scenes: [{ name: 'Cell', nodes: [0, 3, 5, 7] }],
    nodes: [
      { name: 'A', children: [1, 2] },
      { name: 'Pin' }, // 1
      { name: 'Pin' }, // 2 — same-named sibling: "A/Pin" is ambiguous
      { name: 'Twin', children: [4] }, // 3
      { name: 'Sep', extras: { realvirtual: { Drive: {} } } }, // 4
      { name: 'Other', children: [6] }, // 5
      { name: 'Sep', extras: { realvirtual: { Drive: {}, NodeId: 'authored-other-sep' } } }, // 6 — authored id, loads as Sep_1
      {
        name: 'Panel', // 7
        extras: {
          [RV_SEEDED_NODE_ID_KEY]: 'leaked-from-a-writer',
          realvirtual: {
            Drive_Gear: { MasterDrive: CR('Twin/Sep') },
            CustomRuntimeInstruction: { steps: [{ targetObjects: ['A/Pin', 'Other/Sep_1', 'Gone'] }] },
          },
        },
      },
    ],
  };
}

describe('plan-769 Phase 1a — decode identity', () => {
  it('stamps seeds on the RUNTIME key, keeps an authored id, overwrites a leaked runtime key', () => {
    const json = file();
    const { gltf, objs, scene } = fakeParse(json, { 6: 'Sep_1' });
    const identity = decodeIdentity(gltf as never, { fileKey: 'test' })!;
    const seed = seedNodeIdsForFile(json as never);
    expect([...identity.ids]).toEqual(seed.ids);
    expect(identityIdOf(scene)).toBe(seed.rootId);
    objs.forEach((o, i) => expect(identityIdOf(o), `node ${i}`).toBe(seed.ids[i]));
    // Authored id: in realvirtual.NodeId, no runtime key.
    expect(getNodeId(objs[6]!)).toBe('authored-other-sep');
    expect(seededNodeIdOf(objs[6]!)).toBeNull();
    // Seeded: runtime key only — nothing a writer could persist as `NodeId`.
    expect(getNodeId(objs[4]!)).toBeNull();
    expect(seededNodeIdOf(objs[4]!)).toBe(seed.ids[4]);
    // The leaked value is gone; the seed took its place.
    expect(seededNodeIdOf(objs[7]!)).toBe(seed.ids[7]);
    expect(getDecodeIdentity(scene)).toBe(identity);
    expect(stripSeededNodeIds(scene)).toBe(8); // scene + 7 seeded nodes (the authored one has none)
    expect(identityIdOf(objs[4]!)).toBeNull();
  });

  it('migrates every stored path at decode; the on-demand answers equal the decode pass', () => {
    const { gltf } = fakeParse(file(), { 6: 'Sep_1' });
    const identity = decodeIdentity(gltf as never)!;
    expect(identity.counts).toMatchObject({ references: 4, migrated: 2, missing: 1, ambiguous: 1, legacySpelling: 1 });
    expect(identity.migratePath('Twin/Sep')).toEqual({ address: `#${identity.ids[4]}`, via: 'authored' });
    expect(identity.migratePath('Other/Sep_1')).toEqual({ address: '#authored-other-sep', via: 'legacy-three' });
    expect(identity.migratePath('A/Pin')).toEqual({ via: 'unresolved', unresolvedPath: 'A/Pin', reason: 'ambiguous' });
    expect(identity.migratePath('Gone')).toEqual({ via: 'unresolved', unresolvedPath: 'Gone', reason: 'missing' });
    // A path the file never wrote: answered on demand (lookup tables rebuilt), same rules.
    expect(identity.migratePath('Cell/Twin/Sep').address).toBe(`#${identity.ids[4]}`);
    expect(identity.migratePath('Other/Sep').address).toBe('#authored-other-sep');
    expect(identity.authoredPathOf(identity.ids[4]!)).toBe('Twin/Sep');
    expect(identity.authoredPathOf(identity.rootId)).toBe('');
    // The findings: ambiguous, legacy spelling, missing — each named by its referrer.
    expect(identity.findings.map((f) => `${f.outcome}:${f.writtenPath}:${f.referrerAuthoredPath}`).sort()).toEqual([
      'ambiguous:A/Pin:Panel', 'legacy-spelling:Other/Sep_1:Panel', 'missing:Gone:Panel',
    ]);
  });

  it('a result without parser JSON (a test fake, a non-glTF source) has no identity — and does not throw', () => {
    const scene = new Object3D();
    expect(decodeIdentity({ scene })).toBeNull();
    expect(decodeIdentity({ scene, parser: { json: { nodes: 'broken' } } } as never)).toBeNull();
  });

  it('migrate: false (the writer re-parse) seeds ids only', () => {
    const { gltf } = fakeParse(file());
    const identity = decodeIdentity(gltf as never, { migrate: false })!;
    expect(identity.counts.references).toBe(0);
    expect(identity.findings).toEqual([]);
    // On demand it still answers.
    expect(identity.migratePath('Twin/Sep').address).toBe(`#${identity.ids[4]}`);
  });
});
