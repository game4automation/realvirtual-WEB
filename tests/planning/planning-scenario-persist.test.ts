// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 §9.4 — the scenario block survives save → reload.
 *
 * Bytes: `writeDocumentPlanning` patches only the JSON chunk (BIN byte-identical), under
 * the compare-and-swap of the revision it read; an empty block removes itself.
 * Session: the plugin reads the block of a loaded file, the active scenario's values become
 * COMMITTED start values (a reset-class value too — no pending, no apply needed), unusable
 * values are dropped and reported, and a save writes only factor deviations. The reload is
 * a real one: the written bytes go through GLTFLoader, whose scene `userData` is what the
 * viewer hands plugins as `result.root`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { objectToGlb } from '../../src/core/import/rv-import-object';
import { writeDocumentPlanning } from '../../src/core/project/rv-document-planning-write';
import { parseGlbChunks } from '../../src/core/persistence/rv-glb-chunks';
import { revisionOfBytes } from '../../src/core/project/rv-scene-record';
import {
  RV_PLANNING_SCENARIOS_KEY, emptyScenarioBlock, parsePlanningScenarios, withScenario,
  type PlanningScenarioBlock,
} from '../../src/core/planning/rv-planning-scenario';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import type { PlanningParamDef } from '../../src/core/planning/rv-planning-params';
import type { RVViewer } from '../../src/core/rv-viewer';
import {
  docPathOf, type DocRef, type DocumentRecord, type ProjectBackend, type WriteDocumentOptions,
} from '../../src/core/project/backends/project-backend';
import type { RvDocumentEntry } from '../../src/core/project/rv-project-types';

// The save target is the open project's document; in this file a fake backend stands in
// for it (the plan-506 pattern). `saveImpl = null` leaves the real resolver in charge,
// which — with no project open — answers "session only".
let saveImpl: ((block: PlanningScenarioBlock) => Promise<unknown>) | null = null;
vi.mock('../../src/plugins/planning-parameters/scenario-persistence', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/plugins/planning-parameters/scenario-persistence')>();
  return {
    ...orig,
    saveScenarioBlock: (block: PlanningScenarioBlock) => (saveImpl ? saveImpl(block) : orig.saveScenarioBlock(block)),
  };
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

const doc: RvDocumentEntry = { id: 'doc-1', path: 'scenes/Yard.glb', name: 'Yard' };

async function modelBytes(): Promise<Uint8Array> {
  const root = new Group();
  root.name = 'Yard';
  root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x336699 })));
  return new Uint8Array(await objectToGlb(root));
}

function fakeBackend(initial: Uint8Array, writable = true) {
  const state = { bytes: initial, writes: 0, lastOpts: null as WriteDocumentOptions | null, revision: '' };
  const backend = {
    kind: 'folder', id: 'fake', writable, isActive: true,
    async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
      return { bytes: state.bytes, revision: await revisionOfBytes(state.bytes), meta: { id: doc.id, name: doc.name, path: docPathOf(ref) } };
    },
    async readDocumentUrl() { return null; },
    async writeDocument(_ref: DocRef, written: Uint8Array, opts: WriteDocumentOptions) {
      const current = await revisionOfBytes(state.bytes);
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== current) throw new Error('changed since it was read');
      state.bytes = written;
      state.writes += 1;
      state.lastOpts = opts;
      return { revision: await revisionOfBytes(written) };
    },
  } as unknown as ProjectBackend;
  return { backend, state };
}

function sceneRv(bytes: Uint8Array): Record<string, unknown> | undefined {
  const json = parseGlbChunks(bytes).json as { scenes?: Array<{ extras?: { realvirtual?: Record<string, unknown> } }> };
  return json.scenes?.[0]?.extras?.realvirtual;
}

/** What the viewer hands `onModelLoaded`: the loaded scene as `result.root`. */
async function load(bytes: Uint8Array): Promise<{ root: { userData: Record<string, unknown> } }> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  return { root: gltf.scene as unknown as { userData: Record<string, unknown> } };
}

const PARAMS: PlanningParamDef[] = [
  { key: 'size', label: 'Module', type: 'integer', min: 1, max: 16, default: 2, group: 'Größe', apply: 'reset' },
  { key: 'rate', label: 'A1', type: 'number', unit: 'Pal/h', min: 0, max: 120, default: 40, group: 'Last', apply: 'live' },
  { key: 'trace', label: 'Spur', type: 'boolean', default: false, group: 'Anzeige', apply: 'live', role: 'display' },
];

function makeViewer() {
  return {
    simTime: 0,
    uiRegistry: { register: () => {} },
    on: () => () => {},
    whenSceneReady: () => Promise.resolve(),
    setSimulationPaused: () => {},
    resetSimulation: () => {},
    simulationKernel: null,
  } as unknown as RVViewer;
}

let plugin: PlanningParametersPlugin;
let viewer: RVViewer;

beforeEach(() => {
  clearAllProblems();
  localStorage.clear();
  saveImpl = null;
  viewer = makeViewer();
  plugin = new PlanningParametersPlugin();
  plugin.init(viewer);
});

afterEach(() => { plugin.dispose(); clearAllProblems(); localStorage.clear(); });

// ─── Bytes ─────────────────────────────────────────────────────────────────

describe('writeDocumentPlanning', () => {
  it('writes the block into the JSON chunk under the revision it read; BIN byte-identical', async () => {
    const bytes = await modelBytes();
    const { backend, state } = fakeBackend(bytes);
    const block = withScenario(emptyScenarioBlock(), 'Hoch', { 'yard.size': 4, 'yard.rate': 70 });
    const r = await writeDocumentPlanning(backend, doc, block);
    expect(state.writes).toBe(1);
    expect(state.lastOpts?.expectedRevision).toBe(await revisionOfBytes(bytes));
    expect(r.planningScenarios).toEqual(block);
    expect(parsePlanningScenarios(sceneRv(state.bytes)).block).toEqual(block);
    const tail = (b: Uint8Array) => { const c = parseGlbChunks(b); return c.bytes.subarray(c.restOffset); };
    expect(tail(state.bytes).length).toBeGreaterThan(0);
    expect(tail(state.bytes)).toEqual(tail(bytes));
  });

  it('an empty block (only the empty default) removes the key', async () => {
    const { backend, state } = fakeBackend(await modelBytes());
    await writeDocumentPlanning(backend, doc, withScenario(emptyScenarioBlock(), 'Hoch', { 'yard.size': 4 }));
    expect(sceneRv(state.bytes)?.[RV_PLANNING_SCENARIOS_KEY]).toBeDefined();
    const r = await writeDocumentPlanning(backend, doc, emptyScenarioBlock());
    expect(r.planningScenarios).toBeNull();
    expect(sceneRv(state.bytes)?.[RV_PLANNING_SCENARIOS_KEY]).toBeUndefined();
  });

  it('refuses a read-only backend', async () => {
    const { backend } = fakeBackend(await modelBytes(), false);
    await expect(writeDocumentPlanning(backend, doc, emptyScenarioBlock())).rejects.toThrow(/read-only/);
  });
});

// ─── Session: save → reload ────────────────────────────────────────────────

describe('scenario save → reload (plugin)', () => {
  it('round trip: active scenario and values come back; the reset value is committed, not pending; display never stored', async () => {
    const { backend, state } = fakeBackend(await modelBytes());
    saveImpl = async (block) => {
      const r = await writeDocumentPlanning(backend, doc, block);
      return { persistedTo: 'glb', block: r.planningScenarios };
    };

    // First session: a plain document, values changed in the window, saved as "Hoch".
    plugin.onModelLoaded(await load(state.bytes), viewer);
    plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    plugin.registry.setMany({ 'yard.size': 4, 'yard.rate': 70, 'yard.trace': true }, 'ui');
    expect(plugin.isScenarioDirty()).toBe(true);
    const saved = await plugin.saveScenario('Hoch');
    expect(saved.persistedTo).toBe('glb');
    expect(plugin.isScenarioDirty()).toBe(false);
    const stored = parsePlanningScenarios(sceneRv(state.bytes)).block!;
    expect(stored.active).toBe('Hoch');
    expect(stored.scenarios.Hoch).toEqual({ 'yard.rate': 70, 'yard.size': 4 });   // no display value

    // Reload: a new document load in a fresh session.
    plugin.dispose();
    plugin = new PlanningParametersPlugin();
    plugin.init(viewer);
    plugin.onModelLoaded(await load(state.bytes), viewer);
    expect(plugin.getScenarioState().block.active).toBe('Hoch');
    const h = plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    expect(h.values().size).toBe(4);                 // committed start value → the model's load-time rebuild
    expect(h.values().rate).toBe(70);
    expect(plugin.registry.getSnapshot().pendingCount).toBe(0);
    expect(plugin.isScenarioDirty()).toBe(false);
  });

  it('a stored out-of-range value or unknown key is dropped and reported, never clamped', async () => {
    const { backend, state } = fakeBackend(await modelBytes());
    await writeDocumentPlanning(backend, doc, withScenario(emptyScenarioBlock(), 'Basis', {
      'yard.size': 99, 'yard.rate': 80, 'yard.noSuchKey': 1,
    }));
    plugin.onModelLoaded(await load(state.bytes), viewer);
    const h = plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    plugin.registry.reportOrphans();
    expect(h.values().size).toBe(2);                 // default — not 16
    expect(h.values().rate).toBe(80);
    const codes = getProblems().map((p) => p.id);
    expect(codes).toContain('planning-scenario-value-invalid:yard.size');
    expect(codes).toContain('planning-param-orphaned:yard.noSuchKey');
    // The file now differs from what a save would write: dirty.
    expect(plugin.isScenarioDirty()).toBe(true);
  });

  it('a block whose only content was unreadable is dirty, so Save can clean the file', async () => {
    plugin.onModelLoaded({ root: { userData: { realvirtual: { [RV_PLANNING_SCENARIOS_KEY]: {
      version: 1, active: 'Basis', scenarios: { Basis: { 'not a key': 1 } },
    } } } } }, viewer);
    plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    expect(getProblems().some((p) => p.code === 'planning-scenario-value-invalid')).toBe(true);
    expect(plugin.isScenarioDirty()).toBe(true);
  });

  it('a document change while the save is starting writes nothing into the new document', async () => {
    const writes: PlanningScenarioBlock[] = [];
    saveImpl = async (block) => { writes.push(block); return { persistedTo: 'glb', block }; };
    plugin.onModelLoaded({ root: { userData: {} } }, viewer);
    plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    plugin.registry.set('yard.rate', 70, 'ui');
    const pending = plugin.saveScenario();
    plugin.onModelCleared(viewer);                   // the next document arrives before the write
    plugin.onModelLoaded({ root: { userData: {} } }, viewer);
    await expect(pending).rejects.toThrow(/document changed/);
    expect(writes).toEqual([]);
  });

  it('switch to a larger scenario, Save before Apply: the instance values of the rebuild survive', async () => {
    const { backend, state } = fakeBackend(await modelBytes());
    saveImpl = async (block) => {
      const r = await writeDocumentPlanning(backend, doc, block);
      return { persistedTo: 'glb', block: r.planningScenarios };
    };
    let block = withScenario(emptyScenarioBlock(), 'Gross', { 'yard.size': 3, 'yard.station.A3.active': false });
    block = { ...block, active: 'Basis' };
    plugin.onModelLoaded({ root: { userData: { realvirtual: { [RV_PLANNING_SCENARIOS_KEY]: block } } } }, viewer);
    plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    expect(plugin.switchScenario('Gross').ok).toBe(true);   // size pending, A3 dormant (no such key at size 2)
    await plugin.saveScenario();
    expect(parsePlanningScenarios(sceneRv(state.bytes)).block!.scenarios.Gross)
      .toEqual({ 'yard.size': 3, 'yard.station.A3.active': false });
  });

  it('a malformed block is reported and the document starts at the defaults', async () => {
    plugin.onModelLoaded({ root: { userData: { realvirtual: { [RV_PLANNING_SCENARIOS_KEY]: { version: 7 } } } } }, viewer);
    const h = plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    expect(h.values().size).toBe(2);
    expect(getProblems().some((p) => p.code === 'planning-scenario-block-invalid')).toBe(true);
  });

  it('no project open (hosted delivery): save is session-only, the file is untouched', async () => {
    plugin.onModelLoaded({ root: { userData: {} } }, viewer);
    plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    plugin.registry.set('yard.rate', 60, 'ui');
    const r = await plugin.saveScenario();
    expect(r.persistedTo).toBe('session');
    expect(r.reason).toMatch(/session/);
    expect(plugin.isScenarioDirty()).toBe(true);    // nothing reached a file
  });

  it('a document without a block does not inherit the previous document\'s values', async () => {
    plugin.onModelLoaded({ root: { userData: { realvirtual: {
      [RV_PLANNING_SCENARIOS_KEY]: withScenario(emptyScenarioBlock(), 'Basis', { 'yard.size': 5 }),
    } } } }, viewer);
    const h1 = plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    expect(h1.values().size).toBe(5);
    h1.dispose();
    plugin.onModelCleared(viewer);
    plugin.onModelLoaded({ root: { userData: {} } }, viewer);
    expect(plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS }).values().size).toBe(2);
  });

  it('switching scenarios: reset values go pending, live values apply; not saved until Save', async () => {
    let block = withScenario(emptyScenarioBlock(), 'Hoch', { 'yard.size': 6, 'yard.rate': 90 });
    block = { ...block, active: 'Basis' };
    plugin.onModelLoaded({ root: { userData: { realvirtual: { [RV_PLANNING_SCENARIOS_KEY]: block } } } }, viewer);
    const h = plugin.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    expect(plugin.switchScenario('Hoch').ok).toBe(true);
    expect(h.values().rate).toBe(90);
    expect(h.values().size).toBe(2);
    expect(plugin.registry.list().find((p) => p.key === 'yard.size')!.pending).toBe(6);
    expect(plugin.getScenarioState().block.active).toBe('Hoch');
    expect(plugin.isScenarioDirty()).toBe(true);    // the file still says "Basis"
    expect(plugin.switchScenario('Nope').ok).toBe(false);
  });
});
