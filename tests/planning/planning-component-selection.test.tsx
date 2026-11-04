// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 test 9.10 (integration half) + 9.13b (scene origin) — an EXISTING component
 * property in the planning window, end to end:
 *
 *  - a document whose `selection[]` names `Source.Interval` declares it with the schema's
 *    unit, the window shows it, `set` + apply writes it into the component's extras with
 *    exactly one runner reset, and save → GLB → reload brings selection and value back;
 *  - a document without `selection[]` loads as before (no owner, no window, no write);
 *  - ONE writer: every rv_extras write during an apply — of a selected property and of an
 *    experiment factor declared on demand — comes from `writeComponentField`;
 *  - with a real DES runner the first generation after the apply follows the new interval.
 */

import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preloadStructuralResetHull } from '../../src/plugins/planning-parameters/structural-reset';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import '../../src/behaviors/Source';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { PlanningWindow } from '../../src/plugins/planning-parameters/PlanningOverlay';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import {
  componentParamEffectiveKey, registerComponentParamResolver, registerComponentRebuild, type ComponentParamSelection,
} from '../../src/core/planning/rv-planning-component-params';
import { registerParamApply } from '../../src/core/engine/rv-component-registry';
import {
  RV_PLANNING_SCENARIOS_KEY, emptyScenarioBlock, parsePlanningScenarios, planningScenariosPayload,
  withScenario, withSelection, type PlanningScenarioBlock,
} from '../../src/core/planning/rv-planning-scenario';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { writeDocumentPlanning } from '../../src/core/project/rv-document-planning-write';
import { revisionOfBytes } from '../../src/core/project/rv-scene-record';
import { parseGlbChunks } from '../../src/core/persistence/rv-glb-chunks';
import {
  docPathOf, type DocRef, type DocumentRecord, type ProjectBackend,
} from '../../src/core/project/backends/project-backend';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { UISlotProps } from '../../src/core/rv-ui-plugin';
import { DESRunner } from '@rv/plugins/des/des-runner';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { createBindContext, type BindContextHost } from '../../src/core/behavior-runtime';
import { createSelf, type MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';

vi.mock('../../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

// The save target: a fake project backend (plan-506 pattern, as in planning-scenario-persist).
let saveImpl: ((block: PlanningScenarioBlock) => Promise<unknown>) | null = null;
vi.mock('../../src/plugins/planning-parameters/scenario-persistence', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/plugins/planning-parameters/scenario-persistence')>();
  return {
    ...orig,
    saveScenarioBlock: (block: PlanningScenarioBlock) => (saveImpl ? saveImpl(block) : orig.saveScenarioBlock(block)),
  };
});

// ─── A scene + a viewer that knows addresses ───────────────────────────────

interface Scene {
  root: Object3D;
  nodes: Map<string, Object3D>;
}

function scene(entries: Array<[address: string, name: string, extras: Record<string, unknown>]>): Scene {
  const root = new Object3D();
  root.name = 'Root';
  const nodes = new Map<string, Object3D>();
  for (const [address, name, extras] of entries) {
    const n = new Object3D();
    n.name = name;
    n.userData.realvirtual = extras;
    root.add(n);
    nodes.set(address, n);
  }
  return { root, nodes };
}

function makeViewer(s: Scene, kernel: unknown = null) {
  const events = new Map<string, Set<() => void>>();
  const v = {
    simTime: 0,
    isSimulationPaused: false,
    uiRegistry: { register: () => {} },
    on(name: string, fn: () => void) {
      const set = events.get(name) ?? new Set();
      set.add(fn);
      events.set(name, set);
      return () => set.delete(fn);
    },
    emit(name: string) { for (const fn of [...(events.get(name) ?? [])]) fn(); },
    whenSceneReady: () => Promise.resolve(),
    setSimulationPaused: () => {},
    resetSimulation() { v.resets += 1; v.onReset(); v.emit('simulation-reset'); },
    onReset: () => {},
    resets: 0,
    simulationKernel: kernel,
    registry: {
      getNodeByAddress: (nodeId: string, occurrence = '') => s.nodes.get(`${occurrence}#${nodeId}`) ?? null,
      getAddressForNode: (node: Object3D) => [...s.nodes].find(([, n]) => n === node)?.[0] ?? null,
      getPathForNode: (node: Object3D) => `Root/${node.name}`,
      getNode: (path: string) => [...s.nodes.values()].find((n) => `Root/${n.name}` === path) ?? null,
    },
    getPlugin: () => plugin,
  };
  return v;
}

const SEL: ComponentParamSelection = { address: '#src', component: 'Source', field: 'Interval' };
const EFF = componentParamEffectiveKey('#src', 'Source', 'Interval')!;

function withBlock(s: Scene, block: PlanningScenarioBlock | null): { root: Object3D } {
  if (block) {
    (s.root.userData as Record<string, unknown>).realvirtual = { [RV_PLANNING_SCENARIOS_KEY]: planningScenariosPayload(block) };
  }
  return { root: s.root };
}

/** Lets `whenSceneReady().then(...)`, the lazy owner load and the load-time reconciliation run. */
async function settle(): Promise<void> {
  await plugin.whenComponentParamsSettled();
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let plugin: PlanningParametersPlugin;

beforeEach(() => {
  clearAllProblems();
  localStorage.clear();
  saveImpl = null;
  plugin = new PlanningParametersPlugin();
});

afterEach(() => { cleanup(); plugin.dispose(); clearAllProblems(); localStorage.clear(); });

// ─── Selection end to end ──────────────────────────────────────────────────


// plan-2013 Phase 1: the apply hull is a lazy chunk; installed runners preload it at boot.
beforeAll(async () => { await preloadStructuralResetHull(); });

describe('a selected component property (§2.14)', () => {
  it('is declared from selection[] with its schema unit and shown in the window', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2, AutomaticGeneration: true } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [SEL])), viewer as unknown as RVViewer);
    await settle();

    const p = plugin.registry.list().find((x) => x.key === EFF)!;
    expect(p).toBeDefined();
    expect(p.def).toMatchObject({ type: 'number', unit: 's', default: 2, apply: 'reset' });
    expect(p.value).toBe(2);
    expect(viewer.resets).toBe(0);           // declaring writes nothing and resets nothing

    render(
      <ThemeProvider theme={rvDarkTheme}>
        <PlanningWindow viewer={viewer as unknown as UISlotProps['viewer']} />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
    expect(screen.getByText(/Root\/Source · Interval/)).toBeTruthy();
    expect(screen.getAllByText('s').length).toBeGreaterThan(0);
  });

  it('set + apply writes the field and resets exactly once; DES re-reads first', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const reconfigure = vi.fn();
    const viewer = makeViewer(s, { mode: 'continuous', desControl: () => ({ reconfigureFromExtras: reconfigure }) });
    let fieldAtReset: unknown;
    viewer.onReset = () => { fieldAtReset = s.nodes.get('#src')!.userData.realvirtual.Source.Interval; };
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [SEL])), viewer as unknown as RVViewer);
    await settle();

    expect(plugin.registry.set(EFF, 5, 'ui')).toEqual({ ok: true, applied: 'pending' });
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(2);   // pending: nothing written
    const r = await plugin.registry.applyPendingAndReset();
    expect(r.ok).toBe(true);
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(5);
    expect(viewer.resets).toBe(1);
    expect(reconfigure).toHaveBeenCalledTimes(1);
    expect(fieldAtReset).toBe(5);            // write → re-config → reset
  });

  it('save → GLB → reload keeps selection and value, and writes the value into the reloaded field', async () => {
    // A real GLB, a fake writable backend.
    const g = new Group();
    g.name = 'Doc';
    g.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    let bytes: Uint8Array = new Uint8Array(await objectToGlb(g));
    const doc = { id: 'doc-1', path: 'scenes/Doc.glb', name: 'Doc' };
    const backend = {
      kind: 'folder', id: 'fake', writable: true, isActive: true,
      async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
        return { bytes, revision: await revisionOfBytes(bytes), meta: { id: doc.id, name: doc.name, path: docPathOf(ref) } };
      },
      async readDocumentUrl() { return null; },
      async writeDocument(_ref: DocRef, written: Uint8Array) { bytes = written; return { revision: await revisionOfBytes(written) }; },
    } as unknown as ProjectBackend;
    saveImpl = async (block) => ({ persistedTo: 'glb', block: (await writeDocumentPlanning(backend, doc, block)).planningScenarios });

    const s1 = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const v1 = makeViewer(s1);
    plugin.init(v1 as unknown as RVViewer);
    plugin.onModelLoaded({ root: s1.root }, v1 as unknown as RVViewer);
    await settle();
    // The inspector action: show the property, change it, save.
    expect(plugin.showComponentParam(SEL).ok).toBe(true);
    expect(plugin.isScenarioDirty()).toBe(true);
    plugin.registry.set(EFF, 7, 'ui');
    await plugin.saveScenario();
    expect(plugin.isScenarioDirty()).toBe(false);

    // Reload in a fresh session; the file's scene extras are what onModelLoaded sees.
    const json = parseGlbChunks(bytes).json as { scenes: Array<{ extras?: { realvirtual?: Record<string, unknown> } }> };
    const stored = parsePlanningScenarios(json.scenes[0].extras?.realvirtual).block!;
    expect(stored.selection).toEqual([SEL]);
    expect(stored.scenarios.Basis).toEqual({ [EFF]: 7 });
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');

    plugin.dispose();
    plugin = new PlanningParametersPlugin();
    const s2 = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    s2.root.userData = gltf.scene.userData;      // the reloaded document's extras
    const v2 = makeViewer(s2);
    plugin.init(v2 as unknown as RVViewer);
    plugin.onModelLoaded({ root: s2.root }, v2 as unknown as RVViewer);
    await settle();
    expect(plugin.getComponentSelection()).toEqual([SEL]);
    const p = plugin.registry.list().find((x) => x.key === EFF)!;
    expect(p.value).toBe(7);
    expect(p.def.default).toBe(2);            // the document's own value stays the default
    expect(s2.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(7);  // load-time reconciliation
    expect(v2.resets).toBe(1);
    expect(plugin.isScenarioDirty()).toBe(false);
  });

  it('a selected field absent from the extras (schema default) is declared without a write or reset', async () => {
    const s = scene([['#src', 'Source', { Source: { AutomaticGeneration: true } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [SEL])), viewer as unknown as RVViewer);
    await settle();
    expect(plugin.registry.list().find((x) => x.key === EFF)?.value).toBe(0);   // ODT default of Source.Interval
    expect(s.nodes.get('#src')!.userData.realvirtual).toEqual({ Source: { AutomaticGeneration: true } });
    expect(viewer.resets).toBe(0);
  });

  it('a document without selection[] loads unchanged: no owner, no window, nothing written', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, null), viewer as unknown as RVViewer);
    await settle();
    expect(plugin.registry.getSnapshot().owners).toEqual([]);
    expect(plugin.getComponentSelection()).toEqual([]);
    expect(s.nodes.get('#src')!.userData.realvirtual).toEqual({ Source: { Interval: 2 } });
    expect(viewer.resets).toBe(0);
  });

  it('an unsupported or invalid selection entry is reported, not declared', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2, Mass: 1 }, Drive: { TargetSpeed: 100 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [
      { address: '#src', component: 'Drive', field: 'TargetSpeed' },        // no re-config path
      { address: '#src', component: 'Source', field: 'SourceGenerate' },    // a reference
    ])), viewer as unknown as RVViewer);
    await settle();
    expect(plugin.registry.getSnapshot().owners).toEqual([]);
    const codes = getProblems().map((p) => p.code).sort();
    expect(codes).toEqual(['planning-selection-invalid', 'planning-selection-unsupported']);
  });
});

// ─── Codex review (Phase 8) ────────────────────────────────────────────────

describe('document loaded while an experiment batch holds the lock (plan-2005 Phase 7, Codex P7 #3)', () => {
  it('the deferred start values arrive at unlock AND are written into the fields', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.registry.setExperimentRunning(true);   // an old batch still holds the registry
    plugin.onModelLoaded(withBlock(s, withScenario(withSelection(emptyScenarioBlock(), [SEL]), 'Basis', { [EFF]: 8 })), viewer as unknown as RVViewer);
    await settle();
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(2);   // nothing yet
    plugin.registry.setExperimentRunning(false);                                 // the batch ends
    await vi.waitFor(() => expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(8));
    expect(plugin.registry.list().find((p) => p.key === EFF)!.value).toBe(8);
  });
});

describe('review fixes', () => {
  it('#1 the load-time write waits for another owner\'s apply instead of giving up', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    // Another owner's rebuild holds the apply lock while this document loads.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    plugin.registry.declare({
      owner: 'slow', title: 'Slow',
      params: [{ key: 'n', label: 'N', type: 'integer', default: 1, group: 'g', apply: 'reset' }],
      onStructuralReset: () => held,
    });
    plugin.registry.set('slow.n', 2, 'ui');
    const otherApply = plugin.registry.applyPendingAndReset();
    plugin.onModelLoaded(withBlock(s, withScenario(withSelection(emptyScenarioBlock(), [SEL]), 'Basis', { [EFF]: 7 })), viewer as unknown as RVViewer);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(2);   // still waiting
    release();
    await otherApply;
    await settle();
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(7);
  });

  it('#2 a late selection that takes over a stored value writes it into the field', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    // The scenario carries a value for the property, the selection does not (yet).
    plugin.onModelLoaded(withBlock(s, withScenario(emptyScenarioBlock(), 'Basis', { [EFF]: 6 })), viewer as unknown as RVViewer);
    await settle();
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(2);
    expect(plugin.showComponentParam(SEL).ok).toBe(true);
    await settle();
    await plugin.registry.whenApplyIdle();
    expect(plugin.registry.list().find((p) => p.key === EFF)!.value).toBe(6);
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(6);
  });

  it('#3 removing a property drops its value from every scenario and from the dormant values', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    const block = withScenario(withScenario(withSelection(emptyScenarioBlock(), [SEL, { address: '#gone', component: 'Source', field: 'Interval' }]),
      'Hoch', { [EFF]: 9 }, false), 'Basis', { [EFF]: 7, [componentParamEffectiveKey('#gone', 'Source', 'Interval')!]: 3 });
    plugin.onModelLoaded(withBlock(s, block), viewer as unknown as RVViewer);
    await settle();
    expect(plugin.hideComponentParam(SEL)).toBe(true);
    expect(plugin.hideComponentParam({ address: '#gone', component: 'Source', field: 'Interval' })).toBe(true); // never resolved
    const after = plugin.getScenarioState().block;
    expect(after.selection).toBeUndefined();
    expect(after.scenarios.Basis).toEqual({});
    expect(after.scenarios.Hoch).toEqual({});
    expect(plugin.registry.dormant()).toEqual({});
    expect(plugin.registry.list().some((p) => p.owner === 'component')).toBe(false);
  });

  it('#4 an ensure request that outlives its document declares nothing', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, null), viewer as unknown as RVViewer);
    const pending = plugin.ensureComponentParams([SEL]);
    plugin.onModelLoaded(withBlock(s, null), viewer as unknown as RVViewer);   // another document, same addresses
    const [v] = await pending;
    expect(v.ok).toBe(false);
    expect(!v.ok && v.message).toMatch(/document changed/);
    await settle();
    expect(plugin.registry.list().some((p) => p.owner === 'component')).toBe(false);
  });

  it('#6 a selection changed while Save writes stays the session\'s and marks the file behind', async () => {
    const s = scene([['#src', 'Source', { Source: { Interval: 2 } }], ['#src2', 'Source2', { Source: { Interval: 3 } }]]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [SEL])), viewer as unknown as RVViewer);
    await settle();
    let finish!: () => void;
    saveImpl = (block) => new Promise((r) => { finish = () => r({ persistedTo: 'glb', block }); });
    plugin.registry.set(EFF, 5, 'ui');
    const saving = plugin.saveScenario();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(plugin.showComponentParam({ address: '#src2', component: 'Source', field: 'Interval' }).ok).toBe(true);
    finish();
    await saving;
    expect(plugin.getComponentSelection()).toHaveLength(2);
    expect(plugin.getScenarioState().saved.selection).toHaveLength(1);
    expect(plugin.isScenarioDirty()).toBe(true);
  });

  it('#7 a document change during a rebuild handler stops the writer before the next handler', async () => {
    registerParamApply('RebuildA', 'rebuild');
    registerParamApply('RebuildB', 'rebuild');
    const info = () => ({ type: 'number', default: 1 });
    const offs = [
      registerComponentParamResolver('RebuildA', info),
      registerComponentParamResolver('RebuildB', info),
    ];
    let releaseA!: () => void;
    const calls: string[] = [];
    offs.push(registerComponentRebuild('RebuildA', () => { calls.push('A'); return new Promise<void>((r) => { releaseA = r; }); }));
    offs.push(registerComponentRebuild('RebuildB', () => { calls.push('B'); }));
    try {
      const s = scene([['#a', 'A', { RebuildA: { Speed: 1 } }], ['#b', 'B', { RebuildB: { Speed: 1 } }]]);
      const viewer = makeViewer(s);
      plugin.init(viewer as unknown as RVViewer);
      plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [
        { address: '#a', component: 'RebuildA', field: 'Speed' },
        { address: '#b', component: 'RebuildB', field: 'Speed' },
      ])), viewer as unknown as RVViewer);
      await settle();
      plugin.registry.setMany({
        [componentParamEffectiveKey('#a', 'RebuildA', 'Speed')!]: 2,
        [componentParamEffectiveKey('#b', 'RebuildB', 'Speed')!]: 2,
      }, 'ui');
      const apply = plugin.registry.applyPendingAndReset();
      await vi.waitFor(() => expect(calls).toEqual(['A']));
      plugin.onModelLoaded(withBlock(s, null), viewer as unknown as RVViewer);   // document change aborts
      releaseA();
      const r = await apply;
      expect(r.error).toBe('document-changed');
      expect(calls).toEqual(['A']);
    } finally {
      for (const off of offs) off();
      registerParamApply('RebuildA', null);
      registerParamApply('RebuildB', null);
    }
  });
});

// ─── One writer ────────────────────────────────────────────────────────────

describe('one writer (§2.14)', () => {
  it('every rv_extras write of an apply comes from writeComponentField — selected and experiment-declared alike', async () => {
    const s = scene([
      ['#src', 'Source', { Source: { Interval: 2 } }],
      ['#src2', 'Source2', { Source: { Interval: 3 } }],
    ]);
    const viewer = makeViewer(s);
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [SEL])), viewer as unknown as RVViewer);
    await settle();

    // Spy on the component objects: who writes?
    const writers: string[] = [];
    for (const n of s.nodes.values()) {
      const rv = n.userData.realvirtual as Record<string, Record<string, unknown>>;
      rv.Source = new Proxy(rv.Source, {
        set(target, prop, value) {
          writers.push(new Error().stack ?? '');
          target[prop as string] = value;
          return true;
        },
      });
    }

    // An experiment factor declared on demand (plan-2005 Phase 7): hidden, same key format.
    const [verdict] = await plugin.ensureComponentParams([{ address: '#src2', component: 'Source', field: 'Interval' }]);
    expect(verdict.ok).toBe(true);
    const eff2 = componentParamEffectiveKey('#src2', 'Source', 'Interval')!;
    expect(verdict.ok && verdict.effectiveKey).toBe(eff2);
    expect(plugin.registry.list().find((p) => p.key === eff2)!.def.ui?.hidden).toBe(true);
    expect(plugin.getComponentSelection()).toEqual([SEL]);    // not stored in selection[]

    plugin.registry.setMany({ [EFF]: 4, [eff2]: 9 }, 'experiment');
    const r = await plugin.registry.applyPendingAndReset();
    expect(r.ok).toBe(true);
    expect(s.nodes.get('#src')!.userData.realvirtual.Source.Interval).toBe(4);
    expect(s.nodes.get('#src2')!.userData.realvirtual.Source.Interval).toBe(9);
    expect(writers).toHaveLength(2);
    for (const stack of writers) expect(stack).toContain('writeComponentField');
    expect(viewer.resets).toBe(1);
  });
});

// ─── With a real DES runner (9.13b, scene origin) ──────────────────────────

describe('DES: the first generation after the apply follows the new interval', () => {
  const runners: DESRunner[] = [];
  beforeEach(() => { _resetDesHookCache(); __resetDesRunSettingsForTest(); });
  afterEach(() => { for (const r of runners.splice(0)) r.dispose(); __resetDesRunSettingsForTest(); });

  it('Interval 10 → 4: generation times after the apply step by 4', async () => {
    const runner = new DESRunner({ subMode: 'animated' });
    runners.push(runner);
    const generatedAt: number[] = [];
    const source = defineMaterialFlow<MaterialFlowSelf>({
      type: 'PlanTaktSource', kind: 'source', continuous: {},
      schema: { Interval: { type: 'number', default: 10, unit: 's' } },
      des: {
        onGenerate(self) {
          generatedAt.push(runner.getManager().currentTime);
          self.transfer(runner.createMU());
          self.in(Number(self.prop.Interval), 'Generate', null);
        },
      },
    }) as MaterialFlowDefinition;
    const sink = defineMaterialFlow<MaterialFlowSelf>({
      type: 'PlanTaktSink', kind: 'sink', schema: {}, continuous: {},
      des: { onAccept() { return true; } },
    }) as MaterialFlowDefinition;

    const s = scene([
      ['#gen', 'Gen', { PlanTaktSource: { Interval: 10 } }],
      ['#snk', 'Snk', {}],
    ]);
    const events = new EventEmitter<Record<string, unknown>>();
    const host: BindContextHost = {
      signalStore: new SignalStore(),
      on: (e, cb) => events.on(e, cb as never),
      contextMenu: new ContextMenuStore(), drives: [], registry: null, getPlugin: () => undefined,
    };
    const defs = [source, sink];
    const adapters: MaterialFlowAdapter[] = [];
    const nodes = [s.nodes.get('#gen')!, s.nodes.get('#snk')!];
    for (const [i, def] of defs.entries()) {
      const ctx = createBindContext(nodes[i], host, {}).ctx;
      const self = createSelf(ctx, def, {
        mode: 'des', local: (def.state ?? def.local)?.() ?? {},
        scheduler: runner.makeScheduler(def, () => adapters[i].entityId),
        onTransfer: (mu) => runner.makeTransfer(adapters[i])(mu),
      });
      if (i === 0) self.prop.Interval = 10;
      adapters.push(runner.addInstance(def, self, nodes[i]));
    }
    adapters[0].nextComponents = [adapters[1]];
    adapters[1].previousComponents = [adapters[0]];
    runner.start(defs, { root: s.root });
    runner.setEndTime(1000);

    const viewer = makeViewer(s, { mode: 'des', desControl: () => runner, hasDesLifecycle: () => false });
    viewer.onReset = () => { runner.reset(); runner.setEndTime(1000); };
    plugin.init(viewer as unknown as RVViewer);
    plugin.onModelLoaded(withBlock(s, withSelection(emptyScenarioBlock(), [
      { address: '#gen', component: 'PlanTaktSource', field: 'Interval', min: 1, max: 60 },
    ])), viewer as unknown as RVViewer);
    await settle();
    const eff = componentParamEffectiveKey('#gen', 'PlanTaktSource', 'Interval')!;
    expect(plugin.registry.list().find((p) => p.key === eff)?.def).toMatchObject({ unit: 's', default: 10, min: 1, max: 60 });

    plugin.registry.set(eff, 4, 'ui');
    expect((await plugin.registry.applyPendingAndReset()).ok).toBe(true);
    expect(viewer.resets).toBe(1);

    generatedAt.length = 0;
    runner.setSubMode('fastforward');
    for (let i = 0; i < 200 && runner.getManager().currentTime < 20; i++) runner.tick(0);
    const firstFour = generatedAt.slice(0, 4);
    expect(firstFour.length).toBe(4);
    for (let i = 1; i < firstFour.length; i++) expect(firstFour[i] - firstFour[i - 1]).toBeCloseTo(4, 6);
  });
});
