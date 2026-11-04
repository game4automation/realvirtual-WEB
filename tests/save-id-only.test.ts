// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.5 — the editor export stores ids and addresses only (Phase 3a, F1/F2/F8/F17).
 *
 * Load a "Unity" file (paths, no ids) as the asset editor does → export → the DYNAMIC
 * guard of F8: a walker over every stored reference position of the written file
 * (`visitReferences`: every ComponentReference at any depth, every PATH_FIELDS value)
 * finds no path — only `{ address }` and `{ unresolvedPath, reason }`. Every node carries
 * a unique `NodeId`, the scene `idVersion: 1`, no `_` key reaches the file. The reload
 * reads the file WITHOUT migration and finds the same ids and the same targets; a second
 * save writes the same file. Duplicate ids in the input are re-minted with a Problem;
 * a reference that only a guessing stage reaches is written, but reported (F9).
 * Override keys (`AssetOverrides`) are not reference positions in Phase 3 (§ 4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { exportAssetGlb, type ExportIdentityReport } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { expectNoPathInReferences, storedPositionsOf, type WrittenGltfJson } from './helpers/stored-ref-walker';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { CR, box, buildMauserCoreGlb, driveNodeBySpeed, node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { createTestViewer } from './helpers/create-test-viewer';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';
import { auditReferences } from '../src/core/engine/rv-reference-audit';
import { bakeRemovalReport, _resetBakeRemovalReportForTesting } from '../src/core/engine/rv-bake-survival';
import { bakeIntoGlb } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';

type Json = WrittenGltfJson;

async function editorLoad(data: ArrayBuffer, url = 'doc.glb') {
  return loadGLB(url, new Scene(), { data: data.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
}

/** Every key below every extras that starts with `_` (runtime bookkeeping). */
function underscoreKeys(json: Json): string[] {
  const out: string[] = [];
  const deep = (v: unknown, where: string): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((e, i) => deep(e, `${where}[${i}]`)); return; }
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_')) out.push(`${where}.${k}`);
      deep(x, `${where}.${k}`);
    }
  };
  (json.nodes ?? []).forEach((n, i) => deep(n.extras, `node[${i}]`));
  json.scenes?.forEach((s, i) => deep(s.extras, `scene[${i}]`));
  return out;
}

/** Name path → NodeId of every node of a written file (scene root = ''). */
function idsByPath(json: Json): Map<string, string> {
  const m = new Map<string, string>();
  const s = json.scenes![json.scene ?? 0]!;
  const sid = s.extras?.realvirtual?.NodeId;
  if (typeof sid === 'string') m.set('', sid);
  const visit = (i: number, prefix: string): void => {
    const n = json.nodes![i]!;
    const p = prefix ? `${prefix}/${n.name ?? ''}` : (n.name ?? '');
    const id = n.extras?.realvirtual?.NodeId;
    if (typeof id === 'string') m.set(p, id);
    for (const c of n.children ?? []) visit(c, p);
  };
  for (const r of s.nodes ?? []) visit(r, '');
  return m;
}

function liveIdsByPath(registry: NodeRegistry, root: Object3D): Map<string, string> {
  const m = new Map<string, string>();
  const rootPath = registry.getPathForNode(root);
  root.traverse((n) => {
    if (n === root) return;
    const p = registry.getPathForNode(n);
    const id = identityIdOf(n);
    if (p && id) m.set(rootPath && p.startsWith(`${rootPath}/`) ? p.slice(rootPath.length + 1) : p, id);
  });
  return m;
}

describe('plan-769 9.5 — the editor export stores ids and addresses only', () => {
  afterEach(() => { resetProblemsForTests(); vi.restoreAllMocks(); });

  it('Mauser core: no path in a reference position, idVersion 1, every node an id, no `_` key', async () => {
    const loaded = await editorLoad(await buildMauserCoreGlb(), 'mauser-core.glb');
    let report: ExportIdentityReport | null = null;
    const glb = await exportAssetGlb(loaded.root, 'Cell', undefined, undefined, {
      registry: loaded.registry, onIdentityReport: (r) => { report = r; },
    });
    const json = readGlbJson(glb) as Json;
    expectNoPathInReferences(json);
    const positions = storedPositionsOf(json);
    // Drive_Gear.MasterDrive (CR) + CRI target (path field) + Kinematic.Parent (path field).
    expect(positions.filter((p) => p.form === 'address').length).toBe(3);
    expect(positions.filter((p) => p.form === 'unresolved')).toEqual([]);
    expect(json.scenes![0]!.extras!.realvirtual!.idVersion).toBe(1);
    const ids = (json.nodes ?? []).map((n) => n.extras?.realvirtual?.NodeId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(typeof json.scenes![0]!.extras!.realvirtual!.NodeId).toBe('string');
    expect(underscoreKeys(json)).toEqual([]);
    expect(report!.references.addresses).toBe(3);
    expect(report!.ids.reminted).toEqual([]);
    // The written ids ARE the live identities (seeds promoted, nothing re-minted).
    const live = liveIdsByPath(loaded.registry, loaded.root);
    const written = idsByPath(json);
    for (const [p, id] of written) if (p !== '' && live.has(p)) expect(live.get(p), p).toBe(id);
  });

  it('reload reads the file without migration: same ids, same targets; a second save writes the same file', async () => {
    const first = await editorLoad(await buildMauserCoreGlb(), 'mauser-core.glb');
    const glbA = await exportAssetGlb(first.root, 'Cell', undefined, undefined, { registry: first.registry });
    const jsonA = readGlbJson(glbA) as Json;

    const second = await editorLoad(glbA, 'mauser-core-saved.glb');
    const identity = second.registry.identityOfOccurrence('')!;
    expect(identity.idVersion).toBe(1);
    expect(identity.migrated).toBe(false);
    expect(identity.counts.seeded).toBe(0); // every node came with its id
    expect(liveIdsByPath(second.registry, second.root)).toEqual(liveIdsByPath(first.registry, first.root));

    // The stored address names the same AUTHORED node it named before the save.
    let panelNode: Object3D | null = null;
    second.root.traverse((n) => { if (!panelNode && n.name === 'Panel') panelNode = n; });
    const step = ((panelNode!.userData.realvirtual as Record<string, { steps: Array<{ targetObjects: unknown[] }> }>)
      .CustomRuntimeInstruction.steps[0]!.targetObjects[0]);
    expect(step).toMatchObject({ address: expect.stringMatching(/^#/) });
    const r = second.registry.readStoredRef(panelNode!, step as never);
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && second.registry.getAuthoredPath(r.node)).toBe('CadB/Sep/Pin');

    // Save → Save: identical ids and references.
    const glbB = await exportAssetGlb(second.root, 'Cell', undefined, undefined, { registry: second.registry });
    const jsonB = readGlbJson(glbB) as Json;
    expect(idsByPath(jsonB)).toEqual(idsByPath(jsonA));
    expect(storedPositionsOf(jsonB).map((p) => [p.where, p.value])).toEqual(storedPositionsOf(jsonA).map((p) => [p.where, p.value]));
  });

  it('the RUNTIME load (bake) of the saved file binds every address exactly like the original', async () => {
    const original = await buildMauserCoreGlb();
    const loaded = await editorLoad(original, 'mauser-core.glb');
    const saved = await exportAssetGlb(loaded.root, 'Cell', undefined, undefined, { registry: loaded.registry });
    const facts = async (bytes: ArrayBuffer, name: string) => {
      resetProblemsForTests();
      const h = await createTestViewer('webgl');
      try {
        await h.viewer.loadModel(name, { data: bytes.slice(0) });
        const reg = h.viewer.registry!;
        const root = h.viewer.currentModelRoot!;
        const sep = driveNodeBySpeed(root, 222)!;
        let slave: Object3D | null = null;
        let panel: Object3D | null = null;
        root.traverse((n) => { if (n.name === 'Slave') slave = n; if (n.name === 'Panel') panel = n; });
        const drive = reg.componentOn<RVDrive>(slave!, 'Drive');
        const gear = drive?.driveBehaviors.find((b) => b instanceof RVDriveGear) as RVDriveGear | undefined;
        const audit = auditReferences(reg);
        return {
          sepParent: sep.parent?.name, // the Kinematic hook re-parented it under Mount (stored `Parent`)
          gearMaster: gear?.masterDrive?.node === sep,
          instructionTargets: getProblems().filter((p) => p.code === 'unresolved-instruction-target').length,
          auditUnresolved: audit.counts.unresolved,
          auditRescued: audit.counts.rescued,
          survivalUnresolved: bakeRemovalReport[bakeRemovalReport.length - 1]?.counts.unresolvedReferences,
          panel: !!panel,
        };
      } finally {
        h.dispose();
      }
    };
    _resetBakeRemovalReportForTesting();
    const before = await facts(original, 'mauser-core.glb');
    const after = await facts(saved, 'mauser-core-saved.glb');
    expect(before).toEqual({ sepParent: 'Mount', gearMaster: true, instructionTargets: 0, auditUnresolved: 0, auditRescued: 0, survivalUnresolved: 0, panel: true });
    expect(after).toEqual(before);
  });

  it('a NAME field (Source.ThisObjectAsMU) is written as its target\'s address; the saved Source finds the same template', async () => {
    const scene = new Scene();
    scene.name = 'Line';
    const tube = node('Tube');
    tube.add(box('TubeMU', 0.15));
    // Name-as-path: only the migration reads it (the old chain left it unresolved).
    scene.add(tube, node('TubeSource', { Source: { ThisObjectAsMU: 'Tube/TubeMU', Interval: 0, AutomaticGeneration: false } }),
      node('SelfSource', { Source: { ThisObjectAsMU: '', Interval: 0, AutomaticGeneration: false } }));
    const original = await sceneToGlb(scene);
    const loaded = await editorLoad(original, 'line.glb');
    const json = readGlbJson(await exportAssetGlb(loaded.root, 'Line', undefined, undefined, { registry: loaded.registry })) as Json;
    const byName = (n: string) => (json.nodes ?? []).find((x) => x.name === n)!.extras!.realvirtual!;
    expect((byName('TubeSource').Source as Record<string, unknown>).ThisObjectAsMU).toEqual({ address: `#${byName('TubeMU').NodeId}` });
    expect((byName('SelfSource').Source as Record<string, unknown>).ThisObjectAsMU).toBe(''); // "the owner itself" stays
    const saved = await exportAssetGlb(loaded.root, 'Line', undefined, undefined, { registry: loaded.registry });
    const templateOf = async (bytes: ArrayBuffer, name: string) => {
      const h = await createTestViewer('webgl');
      try {
        await h.viewer.loadModel(name, { data: bytes.slice(0) });
        const reg = h.viewer.registry!;
        let src: Object3D | null = null;
        h.viewer.currentModelRoot!.traverse((n) => { if (n.name === 'TubeSource') src = n; });
        const t = reg.componentOn<{ muTemplate: Object3D | null }>(src!, 'Source')?.muTemplate ?? null;
        return t ? reg.getAuthoredPath(t) : null;
      } finally {
        h.dispose();
      }
    };
    expect(await templateOf(original, 'line.glb')).toBe('Tube/TubeMU');
    expect(await templateOf(saved, 'line-saved.glb')).toBe('Tube/TubeMU');
  });

  it('an unresolvable reference is kept as unresolvedPath (D7), an orphan address stays the address', async () => {
    const scene = new Scene();
    scene.name = 'Plant';
    scene.add(
      box('Floor', 1),
      node('Axis', { Drive: { Direction: 'LinearX' } }),
      node('Holder', { RefHolder: { Gone: CR('Plant/DoesNotExist', 'realvirtual.Drive'), Here: CR('Axis', 'realvirtual.Drive') } }),
    );
    const loaded = await editorLoad(await sceneToGlb(scene), 'plant.glb');
    const json = readGlbJson(await exportAssetGlb(loaded.root, 'Plant', undefined, undefined, { registry: loaded.registry })) as Json;
    expectNoPathInReferences(json);
    const holder = (json.nodes ?? []).find((n) => n.name === 'Holder')!.extras!.realvirtual!.RefHolder as Record<string, unknown>;
    expect(holder.Gone).toEqual({ type: 'ComponentReference', unresolvedPath: 'Plant/DoesNotExist', reason: 'missing', componentType: 'realvirtual.Drive' });
    const axisId = (json.nodes ?? []).find((n) => n.name === 'Axis')!.extras!.realvirtual!.NodeId;
    expect(holder.Here).toEqual({ type: 'ComponentReference', address: `#${axisId}`, componentType: 'realvirtual.Drive' });

    // Reload, delete the target's id from the index view (an orphan by id): the address is kept.
    const again = await editorLoad(await exportAssetGlb(loaded.root, 'Plant', undefined, undefined, { registry: loaded.registry }));
    let axis: Object3D | null = null;
    again.root.traverse((n) => { if (n.name === 'Axis') axis = n; });
    again.registry.unregisterNodeId(axis!);
    axis!.removeFromParent();
    const json2 = readGlbJson(await exportAssetGlb(again.root, 'Plant', undefined, undefined, { registry: again.registry })) as Json;
    const holder2 = (json2.nodes ?? []).find((n) => n.name === 'Holder')!.extras!.realvirtual!.RefHolder as Record<string, unknown>;
    expect(holder2.Here).toEqual({ type: 'ComponentReference', address: `#${axisId}`, componentType: 'realvirtual.Drive' });
    expect(holder2.Gone).toEqual(holder.Gone);
  });

  it('duplicate ids in the input: the indexed node keeps its id, the other is re-minted + node-id-duplicate-reminted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    scene.name = 'Plant';
    const dup = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const a = node('A', { NodeId: dup, Drive: { Direction: 'LinearX' } });
    const b = node('B', { NodeId: dup });
    scene.add(a, b, node('Ref', { RefHolder: { To: CR('A', 'realvirtual.Drive') } }));
    resetProblemsForTests();
    const loaded = await editorLoad(await sceneToGlb(scene), 'dup.glb');
    let report: ExportIdentityReport | null = null;
    const json = readGlbJson(await exportAssetGlb(loaded.root, 'Plant', undefined, undefined, {
      registry: loaded.registry, onIdentityReport: (r) => { report = r; },
    })) as Json;
    const byName = (name: string) => (json.nodes ?? []).find((n) => n.name === name)!.extras!.realvirtual!;
    expect(byName('A').NodeId).toBe(dup);
    expect(byName('B').NodeId).not.toBe(dup);
    expect(report!.ids.reminted).toHaveLength(1);
    expect((byName('Ref').RefHolder as Record<string, { address?: string }>).To.address).toBe(`#${dup}`);
    expect(getProblems().filter((p) => p.code === 'node-id-duplicate-reminted')).toHaveLength(1);
    const ids = (json.nodes ?? []).map((n) => n.extras?.realvirtual?.NodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a reference written this session that only a guess reaches is stored, and reported (F9)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    scene.name = 'Plant';
    const station = node('Station');
    station.add(node('Sensor', { Sensor: { Mode: 'Raycast' } }));
    scene.add(station, node('Holder', { RefHolder: { To: CR('Station/Sensor', 'realvirtual.Sensor') } }));
    resetProblemsForTests();
    const loaded = await editorLoad(await sceneToGlb(scene), 'guess.glb');
    let holder: Object3D | null = null;
    loaded.root.traverse((n) => { if (n.name === 'Holder') holder = n; });
    // The web writes a bare leaf name — a path INPUT the file never carried.
    (holder!.userData.realvirtual as Record<string, Record<string, unknown>>).RefHolder.To = CR('Sensor', 'realvirtual.Sensor');
    const json = readGlbJson(await exportAssetGlb(loaded.root, 'Plant', undefined, undefined, { registry: loaded.registry })) as Json;
    expectNoPathInReferences(json);
    const sensorId = (json.nodes ?? []).find((n) => n.name === 'Sensor')!.extras!.realvirtual!.NodeId;
    const to = ((json.nodes ?? []).find((n) => n.name === 'Holder')!.extras!.realvirtual!.RefHolder as Record<string, { address?: string }>).To;
    expect(to.address).toBe(`#${sensorId}`);
    expect(getProblems().filter((p) => p.code === 'reference-saved-from-guess')).toHaveLength(1);
  });

  it('every output: a tree the viewer never loaded (no registry, no decode) is written with ids and addresses too', async () => {
    const root = new Scene();
    root.name = 'Hand';
    const axis = node('Axis', { Drive: { Direction: 'LinearX' } });
    const holder = node('Holder', { RefHolder: { To: CR('Hand/Axis', 'realvirtual.Drive') }, Kinematic: { Parent: 'Axis' } });
    root.add(axis, holder);
    const json = readGlbJson(await exportAssetGlb(root, 'Hand')) as Json;
    expectNoPathInReferences(json);
    expect(json.scenes![0]!.extras!.realvirtual!.idVersion).toBe(1);
    const axisId = (json.nodes ?? []).find((n) => n.name === 'Axis')!.extras!.realvirtual!.NodeId as string;
    const h = (json.nodes ?? []).find((n) => n.name === 'Holder')!.extras!.realvirtual!;
    expect((h.RefHolder as Record<string, { address?: string }>).To.address).toBe(`#${axisId}`);
    expect((h.Kinematic as Record<string, unknown>).Parent).toEqual({ address: `#${axisId}` });
    // Save → Save of the same live tree: minted ids are deterministic and the live tree is untouched.
    const json2 = readGlbJson(await exportAssetGlb(root, 'Hand')) as Json;
    expect(idsByPath(json2)).toEqual(idsByPath(json));
  });

  it('override KEYS are no reference position in Phase 3 (AssetOverrides untouched)', async () => {
    const scene = new Scene();
    scene.name = 'Layout';
    const placement = node('Machine_1', {
      AssetReference: { assetId: 'machine', path: 'machine.glb' },
      AssetOverrides: { byPath: { 'Axis': { Drive: { TargetSpeed: 5 } } } },
    });
    scene.add(placement, box('Floor', 1));
    const loaded = await editorLoad(await sceneToGlb(scene), 'layout.glb');
    const json = readGlbJson(await exportAssetGlb(loaded.root, 'Layout', undefined, undefined, { registry: loaded.registry })) as Json;
    const m = (json.nodes ?? []).find((n) => n.name === 'Machine_1')!.extras!.realvirtual!;
    expect(m.AssetOverrides).toEqual({ byPath: { Axis: { Drive: { TargetSpeed: 5 } } } });
  });
});

// ─── plan-769 Phase 3b: the scene / layout save (bakeIntoGlb) ──────────────

describe('plan-769 9.5 (3b) — the scene save stores ids and addresses only', () => {
  afterEach(() => resetProblemsForTests());

  /** A Unity scene with refs in authored names, a loader-renamed twin, a path field and a placement record. */
  async function unityScene(): Promise<ArrayBuffer> {
    const scene = new Scene();
    scene.name = 'Hall';
    const a = node('Cell');
    a.add(node('Pin', { Drive: { Direction: 'LinearX' } }));
    const b = node('Cell');
    b.add(node('Pin2', { Drive: { Direction: 'LinearX' } }));
    scene.add(a, b,
      node('Holder', { RefHolder: { To: CR('Cell/Pin2', 'realvirtual.Drive') }, Kinematic: { Parent: 'Cell/Pin' } }),
      node('Gone', { RefHolder: { To: CR('Nope/Nothing', 'realvirtual.Drive') } }));
    return sceneToGlb(scene);
  }

  const seededIds = async (bytes: ArrayBuffer): Promise<Map<string, string>> => {
    const l = await editorLoad(bytes, 'hall.glb');
    const m = new Map<string, string>();
    // Keyed by authored name + the authored names of its children (the twin cells differ there).
    const authored = (n: Object3D): string => (n.userData._rvOrigName as string | undefined) ?? n.name;
    l.root.traverse((n) => { const id = identityIdOf(n); if (id && n !== l.root) m.set(`${authored(n)}[${n.children.map(authored).join(',')}]`, id); });
    return m;
  };

  it('fast path (JSON patch): every node an id equal to its load-time seed, addresses only, idVersion 1', async () => {
    const source = await unityScene();
    const before = await seededIds(source);
    const edits = materialise([{
      id: 'op1', ts: 0, schemaV: 1, kind: 'setField', nodePath: 'Hall/Holder', componentType: 'RefHolder', fieldName: 'Speed', value: 5, prev: undefined,
    } as never]);
    const baked = await bakeIntoGlb(source, edits, { locate: (p) => (p === 'Hall/Holder' ? { kind: 'root', index: 4 } : null) });
    expect(baked.path).toBe('fast');
    const json = readGlbJson(baked.glb) as Json;
    expectNoPathInReferences(json);
    expect(json.scenes![0]!.extras!.realvirtual!.idVersion).toBe(1);
    const ids = (json.nodes ?? []).map((n) => n.extras?.realvirtual?.NodeId);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const after = await seededIds(baked.glb.slice().buffer);
    expect(after).toEqual(before); // same ids, now persisted
    const holder = (json.nodes ?? []).find((n) => n.name === 'Holder')!.extras!.realvirtual!;
    const pin2 = (json.nodes ?? []).find((n) => n.name === 'Pin2')!.extras!.realvirtual!.NodeId;
    const pin = (json.nodes ?? []).find((n) => n.name === 'Pin')!.extras!.realvirtual!.NodeId;
    expect((holder.RefHolder as Record<string, unknown>).To).toEqual({ type: 'ComponentReference', address: `#${pin2}`, componentType: 'realvirtual.Drive' });
    expect((holder.Kinematic as Record<string, unknown>).Parent).toEqual({ address: `#${pin}` });
    const gone = (json.nodes ?? []).find((n) => n.name === 'Gone')!.extras!.realvirtual!;
    expect((gone.RefHolder as Record<string, unknown>).To).toMatchObject({ unresolvedPath: 'Nope/Nothing', reason: 'missing' });
  });

  it('full path (re-export): the loader-renamed twin keeps its id and its reference; a placement keeps its record id', async () => {
    const source = await unityScene();
    const before = await seededIds(source);
    const placement = { id: 'pl-9', catalogId: 'machine', label: 'Machine_1', position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const edits = materialise([{ id: 'op1', ts: 0, schemaV: 1, kind: 'addPlacement', placement } as never]);
    const baked = await bakeIntoGlb(source, edits, { locate: () => null });
    expect(baked.path).toBe('full');
    const json = readGlbJson(baked.glb) as Json;
    expectNoPathInReferences(json);
    expect(json.scenes![0]!.extras!.realvirtual!.idVersion).toBe(1);
    expect((json.nodes ?? []).find((n) => n.name === 'Machine_1')!.extras!.realvirtual!.NodeId).toBe('pl-9');
    const after = await seededIds(baked.glb.slice().buffer);
    for (const [k, id] of before) expect(after.get(k), k).toBe(id);
    // The reference to the renamed twin's child still names it after a reload.
    const reloaded = await editorLoad(baked.glb.slice().buffer, 'hall-saved.glb');
    let holder: Object3D | null = null;
    reloaded.root.traverse((n) => { if (n.name === 'Holder') holder = n; });
    const to = (holder!.userData.realvirtual as Record<string, Record<string, unknown>>).RefHolder.To;
    const r = reloaded.registry.readStoredRef(holder!, to as never);
    expect(r.status === 'resolved' && r.node.name).toBe('Pin2');
  });
});
