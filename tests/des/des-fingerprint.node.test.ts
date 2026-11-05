// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2059 Phase 1 — the STRICT DES fingerprint (Thomas 2026-11-02: a snapshot
 * only continues on the 1:1 identical model) + the content ledger + the
 * model-input collector (Gate R4 #1/#2).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Object3D, Quaternion, Vector3 } from 'three';
import {
  buildDesFingerprint,
  canonicalFingerprintJson,
  sha256HexUtf8,
  pathGraphRows,
  sameDesFingerprint,
  type FingerprintInput,
  type DesFingerprint,
} from '../../src/plugins/des/rv-des-fingerprint';
import {
  recordDocumentBytes,
  documentHashOf,
  whenDocumentHashesSettled,
  clearModelContentLedger,
} from '../../src/core/engine/rv-model-content-ledger';
import { collectModelInput, type ModelInputHost, type ModelInputRunner } from '../../src/plugins/des/rv-des-model-input';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { RVPathNetwork } from '../../src/core/engine/rv-path-network';
import { findDesManager, isDesRunConfigField } from '../../src/core/material-flow/des-manager-settings';

const ID = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];
const ready = (sha256: string) => ({ state: 'ready' as const, sha256 });

function base(): FingerprintInput {
  return {
    runtimeVersion: 'test', rngVersion: 2,
    documents: [
      { occurrence: '', key: 'blob:http://x/aaa', hash: ready('a'.repeat(64)) },
      { occurrence: 'p1#n1', key: 'resolved:asset-1', hash: ready('b'.repeat(64)) },
    ],
    scene: [
      { address: '#c1', parent: '', extras: { Conveyor: { Speed: 500 }, Material: { Color: '#ff0000' } }, matrix: ID },
      { address: 'p1#n1', parent: '', extras: { LayoutObject: {}, AssetOverrides: { byAddress: {} } }, matrix: ID },
    ],
    components: [{ id: '#c1@Conveyor', type: 'Conveyor' }],
    scripts: [{ id: '#s1@Script', source: 'export default () => ({})' }],
    runConfig: { seed: 42, warmup: 0, runLength: 3600 },
    pathGraph: [{ id: 'P', length: 10, closed: false, successorIds: [], zoneId: null, zoneCapacity: null, align: [0, 1, 0], segments: [] }],
  };
}

function fp(input: FingerprintInput): DesFingerprint {
  const r = buildDesFingerprint(input);
  if (!r.ok) throw new Error(r.reasons.join('; '));
  return r.fingerprint;
}

describe('plan-2059 P1: strict fingerprint', () => {
  it('reads CycleTime without injecting defaults, and hashes an explicit motion step as model content', () => {
    const root = new Object3D(); root.name = 'Simulation';
    const extras = { DESManager: { EndTime: 100 } };
    root.userData.realvirtual = extras;
    const before = JSON.stringify(root.userData);
    const input: FingerprintInput = { ...base(), scene: [{ address: '#simulation', parent: '', matrix: ID, extras }] };
    const originalHash = fp(input).modelHash;
    expect(findDesManager(root)?.cycleTime).toBe(1 / 60);
    expect(JSON.stringify(root.userData)).toBe(before);
    expect(fp(input).modelHash).toBe(originalHash);
    expect(isDesRunConfigField('DESManager', 'CycleTime')).toBe(false);
    const changed: FingerprintInput = { ...base(),
      scene: [{ ...input.scene[0], extras: { DESManager: { EndTime: 100, CycleTime: 0.01 } } }] };
    expect(fp(changed).modelHash).not.toBe(originalHash);
  });

  it.each([[0.0001, 0.001], [0.5, 0.1], [0.01, 0.01], [NaN, 1 / 60], [Infinity, 1 / 60]])(
    'clamps CycleTime %s to %s without changing authored extras', (raw, expected) => {
      const root = new Object3D(); root.userData.realvirtual = { DESManager: { CycleTime: raw } };
      expect(findDesManager(root)).toMatchObject({ cycleTime: expected, rawCycleTime: raw });
      expect(root.userData.realvirtual.DESManager.CycleTime).toBe(raw);
    });
  it('equal input in any order → equal hash; carries {id,type} + versions', () => {
    const a = fp(base());
    const b0 = base();
    const b = fp({
      ...b0,
      documents: [...b0.documents].reverse(),
      scene: [...b0.scene].reverse(),
      components: [...b0.components].reverse(),
    });
    expect(b.modelHash).toBe(a.modelHash);
    expect(a.modelHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.components).toEqual([{ id: '#c1@Conveyor', type: 'Conveyor' }]);
    expect(a.schemaVersion).toBe(4);
    expect(sameDesFingerprint(a, b)).toBe(true);
  });

  it('R4 #1: the ledger key (blob URL) is not hashed — same bytes under another URL → same hash', () => {
    const b0 = base();
    const moved = { ...b0, documents: b0.documents.map((d) => ({ ...d, key: `${d.key}-reopened` })) };
    expect(fp(moved).modelHash).toBe(fp(b0).modelHash);
  });

  const variants: Array<[string, (i: FingerprintInput) => FingerprintInput]> = [
    ['one byte of the main document', (i) => ({ ...i, documents: [{ ...i.documents[0], hash: ready('c'.repeat(64)) }, i.documents[1]] })],
    ['presentation (colour) in extras', (i) => ({ ...i, scene: [{ ...i.scene[0], extras: { Conveyor: { Speed: 500 }, Material: { Color: '#00ff00' } } }, i.scene[1]] })],
    ['a DES property', (i) => ({ ...i, scene: [{ ...i.scene[0], extras: { Conveyor: { Speed: 501 }, Material: { Color: '#ff0000' } } }, i.scene[1]] })],
    ['moving a purely visual placement (R4 #2)', (i) => ({ ...i, scene: [i.scene[0], { ...i.scene[1], matrix: [...ID.slice(0, 12), 1, 0, 0, 1] }] })],
    ['overrides of a placement without DES component (R4 #2)', (i) => ({ ...i, scene: [i.scene[0], { ...i.scene[1], extras: { LayoutObject: {}, AssetOverrides: { byAddress: { '#x': { Visible: false } } } } }] })],
    ['copying a placement (new occurrence)', (i) => ({ ...i, documents: [...i.documents, { occurrence: 'p2#n1', key: 'resolved:asset-1', hash: ready('b'.repeat(64)) }] })],
    ['reparenting a node (same transforms, other parent) — review finding 1', (i) => ({ ...i, scene: [{ ...i.scene[0], parent: 'p1#n1' }, i.scene[1]] })],
    ['script source', (i) => ({ ...i, scripts: [{ id: '#s1@Script', source: 'export default () => ({ a: 1 })' }] })],
    ['path graph', (i) => ({ ...i, pathGraph: [{ ...i.pathGraph[0], length: 10.5 }] })],
    ['runtimeVersion', (i) => ({ ...i, runtimeVersion: 'next-release' })],
    ['rngVersion', (i) => ({ ...i, rngVersion: 1 })],
    ['{id,type} swap', (i) => ({ ...i, components: [{ id: '#c1@Conveyor', type: 'Station' }] })],
  ];
  for (const [what, change] of variants) {
    it(`any change → other hash: ${what}`, () => {
      expect(fp(change(base())).modelHash).not.toBe(fp(base()).modelHash);
    });
  }

  it('run parameters are NOT model: other runConfig -> same modelHash, other runConfigHash (Thomas 2026-11-01)', () => {
    const a = fp(base());
    const b = fp({ ...base(), runConfig: { seed: 43, warmup: 5, runLength: 7200 } });
    expect(b.modelHash).toBe(a.modelHash);
    expect(b.runConfigHash).not.toBe(a.runConfigHash);
    expect(sameDesFingerprint(a, b)).toBe(true);
  });

  it('never a silent subset: pending/unavailable document, missing id, duplicate → incomplete', () => {
    const b0 = base();
    const cases: FingerprintInput[] = [
      { ...b0, documents: [{ occurrence: '', hash: { state: 'pending' } }] },
      { ...b0, documents: [{ occurrence: '', hash: { state: 'unavailable', reason: 'read failed' } }] },
      { ...b0, documents: [b0.documents[0], { occurrence: null, key: 'k', hash: ready('b'.repeat(64)) }] },
      { ...b0, components: [{ id: null, type: 'Conveyor' }] },
      { ...b0, components: [b0.components[0], b0.components[0]] },
      { ...b0, scene: [b0.scene[0], b0.scene[0]] },
    ];
    for (const c of cases) {
      const r = buildDesFingerprint(c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it('canonical JSON: keys sorted, non-finite / -0 / Map / Set encoded, functions refused', () => {
    expect(canonicalFingerprintJson({ b: 1, a: [NaN, -0, Infinity] }))
      .toBe('{"a":[{"$num":"NaN"},{"$num":"-0"},{"$num":"Infinity"}],"b":1}');
    expect(canonicalFingerprintJson(new Map([['b', 1], ['a', 2]]))).toBe(canonicalFingerprintJson(new Map([['a', 2], ['b', 1]])));
    expect(canonicalFingerprintJson(new Set([2, 1]))).toBe('{"$set":[1,2]}');
    expect(() => canonicalFingerprintJson({ f: () => 1 })).toThrow();
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(() => canonicalFingerprintJson(cyc)).toThrow(/cycle/);
  });

  it('sync SHA-256 matches node:crypto', () => {
    for (const t of ['', 'abc', 'ä€😀', 'x'.repeat(1000)]) {
      expect(sha256HexUtf8(t)).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
    }
  });

  it('pathGraphRows reads an RVPathNetwork (ids, length, successors, segment points)', () => {
    const net = new RVPathNetwork();
    net.register(parsePathExtras({ type: 'Path', version: 1, id: 'A', align: [0, 1, 0], successors: ['B'],
      segments: [{ kind: 'line', from: [0, 0, 0], to: [2, 0, 0] }] }, 'A')!);
    const rows = pathGraphRows(net);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('A');
    expect(rows[0].length).toBeCloseTo(2);
    expect(rows[0].successorIds).toEqual(['B']);
    expect(rows[0].segments[0].pm).toEqual([1, 0, 0]);
  });
});

describe('plan-2059 P1: content ledger', () => {
  beforeEach(() => clearModelContentLedger());

  it('hashes the exact bytes (SHA-256), pending until settled, re-record replaces', async () => {
    const bytes = new TextEncoder().encode('glTF-fake-bytes');
    recordDocumentBytes('k', bytes.buffer.slice(0));
    expect(['pending', 'ready']).toContain(documentHashOf('k').state);
    await whenDocumentHashesSettled();
    expect(documentHashOf('k')).toEqual({ state: 'ready', sha256: createHash('sha256').update(bytes).digest('hex') });
    recordDocumentBytes('k', new TextEncoder().encode('other').buffer);
    await whenDocumentHashesSettled();
    expect((documentHashOf('k') as { sha256: string }).sha256).toBe(createHash('sha256').update('other').digest('hex'));
  });

  it('small buffers are consumed before the first yield', async () => {
    const buf = new TextEncoder().encode('abc').buffer;
    recordDocumentBytes('k', buf);
    new Uint8Array(buf).fill(0);
    await whenDocumentHashesSettled();
    expect((documentHashOf('k') as { sha256: string }).sha256).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('review finding 2: an abandoned decode never publishes, also when its fetch returns last', async () => {
    let epoch = 0;
    const guard = (e: number) => () => epoch === e;
    // old decode started at epoch 0, digest pending …
    recordDocumentBytes('asset', new TextEncoder().encode('old').buffer, { isCurrent: guard(0) });
    epoch = 1; // invalidate()
    recordDocumentBytes('asset', new TextEncoder().encode('new').buffer, { isCurrent: guard(1) });
    await whenDocumentHashesSettled();
    expect((documentHashOf('asset') as { sha256: string }).sha256).toBe(createHash('sha256').update('new').digest('hex'));
    // … and an old fetch that only now records (returns last) is ignored.
    recordDocumentBytes('asset', new TextEncoder().encode('old').buffer, { isCurrent: guard(0) });
    await whenDocumentHashesSettled();
    expect((documentHashOf('asset') as { sha256: string }).sha256).toBe(createHash('sha256').update('new').digest('hex'));
    // A decode abandoned while its own digest runs does not publish a stale hash.
    recordDocumentBytes('asset2', new TextEncoder().encode('x').buffer, { isCurrent: guard(1) });
    epoch = 2;
    await whenDocumentHashesSettled();
    expect(documentHashOf('asset2').state).toBe('unavailable');
  });

  it('unknown keys are unavailable', () => {
    expect(documentHashOf('never').state).toBe('unavailable');
  });
});

describe('plan-2059 P1: collectModelInput (R4 #1/#2)', () => {
  function world() {
    const nodes = new Map<Object3D, string>();
    const conveyor = new Object3D(); conveyor.userData.realvirtual = { Conveyor: { Speed: 500 } };
    const drive = new Object3D(); drive.userData.realvirtual = { Drive: {} };
    const agv = new Object3D(); agv.userData.realvirtual = { Agv: { PathId: 'P' } };
    const visual = new Object3D(); visual.userData.realvirtual = { LayoutObject: {} };
    const synthetic = new Object3D();
    nodes.set(conveyor, '#c1'); nodes.set(drive, '#d1'); nodes.set(agv, '#a1'); nodes.set(visual, 'pv#root');
    const all = [conveyor, drive, agv, visual, synthetic];
    const home = new Vector3(0, 0, 0);
    const host: ModelInputHost = {
      registry: {
        forEachNode: (cb) => { for (const n of all) cb(n.name, n); cb('alias', conveyor); },
        getAddressForNode: (n) => nodes.get(n) ?? null,
      },
      bakeRegistry: { instances: new Set([
        { root: new Object3D(), baked: { assetId: 'blob:main-1' } },
        { root: visual, baked: { assetId: 'resolved:visual' } },
      ]) },
      drives: [{ node: drive, getHomeLocalPosition: () => home.clone(), getHomeLocalQuaternion: () => new Quaternion() }],
    };
    const runner: ModelInputRunner = { liveInstances: [
      { def: { type: 'Conveyor' }, adapter: { node: conveyor }, desId: '#c1@Conveyor', bindPoses: new Map() },
      { def: { type: 'Agv' }, adapter: { node: agv }, desId: '#a1@Agv', bindPoses: new Map([[agv, ID]]) },
    ] };
    return { host, runner, conveyor, drive, agv, visual };
  }
  const hashOf = (k: string) => ready(k.includes('visual') ? 'v'.repeat(64) : 'm'.repeat(64));
  const hashFor = (w: ReturnType<typeof world>, mainKey: string): string => {
    const input = collectModelInput(w.host, w.runner, { mainDocumentKey: mainKey, hashOf });
    return fp({ runtimeVersion: 'test', rngVersion: 2, ...input, scripts: [], runConfig: null, pathGraph: [] }).modelHash;
  };

  it('main model is occurrence "", placements by root address; each addressed node once; synthetic skipped', () => {
    const w = world();
    const input = collectModelInput(w.host, w.runner, { mainDocumentKey: 'blob:main-1', hashOf });
    expect(input.documents.map((d) => d.occurrence).sort()).toEqual(['', 'pv#root']);
    expect(input.scene.map((s) => s.address).sort()).toEqual(['#a1', '#c1', '#d1', 'pv#root']);
    expect(input.components.map((c) => c.id)).toEqual(['#c1@Conveyor', '#a1@Agv']);
  });

  it('reopen under a new blob URL → same hash (R4 #1)', () => {
    const a = world();
    const b = world();
    const insts = [...b.host.bakeRegistry!.instances];
    (insts[0].baked as { assetId: string }).assetId = 'blob:main-2';
    expect(hashFor(b, 'blob:main-2')).toBe(hashFor(a, 'blob:main-1'));
  });

  it('drive motion and Agv travel after bind do NOT change the hash; a planner move of a visual placement does', () => {
    const w = world();
    const before = hashFor(w, 'blob:main-1');
    w.drive.position.set(0, 0.7, 0);       // drive moved during the run → home pose used
    w.agv.position.set(12, 0, 3);          // Agv drove → pose at bind used
    w.agv.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1);
    expect(hashFor(w, 'blob:main-1')).toBe(before);
    w.visual.position.set(5, 0, 0);        // planner move of a placement without DES component
    expect(hashFor(w, 'blob:main-1')).not.toBe(before);
  });

  it('reparenting an addressed node changes the hash even with identical transforms (review finding 1)', () => {
    const w = world();
    const before = hashFor(w, 'blob:main-1');
    w.visual.add(w.conveyor); // identity transforms everywhere → only the parent differs
    expect(collectModelInput(w.host, w.runner, { mainDocumentKey: 'blob:main-1', hashOf })
      .scene.find((n) => n.address === '#c1')!.parent).toBe('pv#root');
    expect(hashFor(w, 'blob:main-1')).not.toBe(before);
  });

  it('moving a static DES component (conveyor) changes the hash', () => {
    const w = world();
    const before = hashFor(w, 'blob:main-1');
    w.conveyor.position.set(0, 0, 1);
    expect(hashFor(w, 'blob:main-1')).not.toBe(before);
  });

  it('a main model without bake instance still contributes its bytes', () => {
    const w = world();
    const host: ModelInputHost = { ...w.host, bakeRegistry: { instances: new Set() } };
    const input = collectModelInput(host, w.runner, { mainDocumentKey: 'blob:main-1', hashOf });
    expect(input.documents).toEqual([{ occurrence: '', key: 'blob:main-1', hash: ready('m'.repeat(64)) }]);
  });
});
