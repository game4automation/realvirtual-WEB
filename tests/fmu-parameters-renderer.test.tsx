// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-502 §9.5 — the parameters renderer of `Fmu.FmuVariables` (plan-510:
 * InspectorRow rows, label = variable name, override = the row's dot,
 * "Save as start value" = trailing icon, package details collapsed at the end).
 *
 * Like `ribbon-rollers-renderer.test.tsx`, the component is taken out of
 * `fieldRendererRegistry` AFTER `App.tsx` was imported — the production
 * bootstrap path; a renderer App.tsx does not import would fail here.
 *
 * The rest runs against real parts: an `RVFmu` constructed by the asset
 * executors from a real package (`attachFmu` on an AssetDocument), a real
 * `SignalStore`, and an edit target over that document — so "Save as start
 * value" is asserted as the stored map and as an undoable document step.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { Group, Object3D, Scene } from 'three';
import type { ComponentType } from 'react';
import feedthroughUrl from './fixtures/Feedthrough.fmu?url';
import bouncingBallUrl from './fixtures/BouncingBall.fmu?url';
import { fieldRendererRegistry, type FieldRendererProps } from '../src/core/hmi/rv-field-renderer-registry';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { isFieldHidden } from '../src/core/hmi/rv-inspector-helpers';
import type { RVViewer } from '../src/core/rv-viewer';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import {
  RVFmu,
  fmuOf,
  getFmuInstances,
  setFmuDocumentIdProvider,
  subscribeFmuOverridesChanged,
  type FmuOverridesChange,
} from '../src/core/engine/rv-fmu';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { attachFmu, type FmuPackage } from '../src/core/ops/rv-fmu-ops';
import { assetOpHeader } from '../src/core/editor/rv-asset-ops';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { _forgetDraftFmuMemoryForTesting } from '../src/core/editor/rv-asset-draft-storage';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { InspectorRow } from '../src/core/hmi/rv-inspector-row';
import {
  FMU_INPUTS_TITLE,
  FMU_PARAMETERS_TITLE,
  FMU_RESTART_HINT,
  FMU_RERANGE_HINT,
} from '../src/core/hmi/rv-fmu-parameters-field-renderer';
import { sha256HexOf } from './helpers/glb-fixture';

const BOOTSTRAP_TIMEOUT = 180_000;
let Renderer: ComponentType<FieldRendererProps>;

beforeAll(async () => {
  await import('../src/core/hmi/App');
  const found = fieldRendererRegistry.getRenderer('Fmu', 'FmuVariables');
  if (!found) {
    throw new Error("Fmu.FmuVariables has no field renderer after importing App.tsx — `import './rv-fmu-parameters-field-renderer'` is missing.");
  }
  Renderer = found;
}, BOOTSTRAP_TIMEOUT);

// ─── Environment ────────────────────────────────────────────────────────

interface Env {
  viewer: RVViewer;
  model: Group;
  store: SignalStore;
  pathOf(name: string): string;
  node(name: string): Object3D;
}

function mockViewer(nodeNames = ['Ball', 'Panel']): Env {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  for (const n of nodeNames) {
    const o = new Object3D();
    o.name = n;
    model.add(o);
  }
  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const store = new SignalStore();
  const viewer = {
    scene, registry, signalStore: store, transportManager: {},
    get currentModelRoot() { return model; },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; }, rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return {
    viewer, model, store,
    pathOf: (name) => NodeRegistry.computeNodePath(model.getObjectByName(name)!),
    node: (name) => model.getObjectByName(name)!,
  };
}

interface Recorder { target: EditTarget; ops: Array<{ kind: string; fieldName: string; value?: unknown }> }

/** The asset-editor edit target over an AssetDocument, recording every op it forwards. */
function docTarget(doc: AssetDocument): Recorder {
  const ops: Recorder['ops'] = [];
  const target: EditTarget = {
    available: true,
    persistsTo: 'asset',
    setField(nodePath, componentType, fieldName, value, prev) {
      ops.push({ kind: 'setField', fieldName, value });
      void doc.applyOp({ ...assetOpHeader(), kind: 'setField', nodePath, componentType, fieldName, value, prev });
    },
    unsetField(nodePath, componentType, fieldName, prev) {
      ops.push({ kind: 'unsetField', fieldName });
      void doc.applyOp({ ...assetOpHeader(), kind: 'unsetField', nodePath, componentType, fieldName, prev });
    },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(target);
  return { target, ops };
}

const pkgs = new Map<string, FmuPackage>();
async function pkg(url: string, fileName: string): Promise<FmuPackage> {
  const cached = pkgs.get(url);
  if (cached) return cached;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const { readModelDescription } = await import('../src/core/engine/rv-fmu-model-description');
  const p = { fileName, sha256: await sha256HexOf(bytes), bytes, description: await readModelDescription(bytes) };
  pkgs.set(url, p);
  return p;
}

interface Mounted { env: Env; doc: AssetDocument; rec: Recorder; fmu(): RVFmu; nodePath: string }

async function mount(which: 'ball' | 'feedthrough', mutate?: (p: FmuPackage) => FmuPackage): Promise<Mounted> {
  const env = mockViewer();
  const doc = scratchAssetDocument(env.viewer);
  const rec = docTarget(doc);
  const nodeName = which === 'ball' ? 'Ball' : 'Panel';
  const nodePath = env.pathOf(nodeName);
  let p = which === 'ball' ? await pkg(bouncingBallUrl, 'BouncingBall.fmu') : await pkg(feedthroughUrl, 'Feedthrough.fmu');
  if (mutate) p = mutate(p);
  await attachFmu(doc, nodePath, p);
  render(
    <Renderer
      value={[]}
      fieldName="FmuVariables"
      componentType="Fmu"
      nodePath={nodePath}
      viewer={env.viewer}
      signalStore={env.store}
    />,
  );
  return { env, doc, rec, nodePath, fmu: () => fmuOf(env.node(nodeName))! };
}

async function settle(doc: AssetDocument): Promise<void> {
  await act(async () => { await doc.whenIdle(); });
}

function numberInput(name: string): HTMLInputElement {
  // plan-510: number fields are text inputs with inputMode="decimal".
  return within(screen.getByTestId(`fmu-param-row-${name}`)).getByRole('textbox') as HTMLInputElement;
}

let clock = 0;
function tick(ms = 1_000): void { clock += ms; }

beforeEach(() => {
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  binaryResources._resetForTesting();
  resetProblemsForTests();
  setFmuDocumentIdProvider(null);
  for (const i of [...getFmuInstances()]) i.dispose();
  _forgetDraftFmuMemoryForTesting();
});

afterEach(() => {
  cleanup();
  setActiveEditTarget(null);
  vi.restoreAllMocks();
  for (const i of [...getFmuInstances()]) i.dispose();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Fmu.FmuVariables renderer — registration and rows', () => {
  it('is registered through the App bootstrap and wins: FmuVariables is not hidden, the raw override map is', () => {
    expect(isFieldHidden('Fmu', 'FmuVariables')).toBe(false);
    expect(isFieldHidden('Fmu', 'FmuStartOverrides')).toBe(true);
    expect(isFieldHidden('Fmu', 'RestartOnReset')).toBe(false);
  });

  it('BouncingBall: rows only for e and g (no output h/v, no constant v_min), grouped as parameters', async () => {
    const m = await mount('ball');
    expect(screen.queryByText('Inputs & Parameter')).toBeNull();
    expect(screen.getByTestId('fmu-param-row-e')).toBeTruthy();
    expect(screen.getByTestId('fmu-param-row-g')).toBeTruthy();
    for (const n of ['h', 'v', 'v_min', 'time']) expect(screen.queryByTestId(`fmu-param-row-${n}`)).toBeNull();
    // Label = variable name, description in the tooltip; unit with superscript, range hint only where declared.
    expect(screen.getByTestId('fmu-param-label-e').textContent).toBe('e');
    expect(screen.getByTestId('fmu-param-label-e').closest('[title]')?.getAttribute('title')).toContain('Coefficient of restitution');
    expect(within(screen.getByTestId('fmu-param-row-e')).getByTestId('rv-number-range').textContent).toBe('0.5…1');
    expect(within(screen.getByTestId('fmu-param-row-g')).queryByTestId('rv-number-range')).toBeNull();
    expect(within(screen.getByTestId('fmu-param-row-g')).getByText('m/s²')).toBeTruthy();
    expect(screen.getByText(FMU_PARAMETERS_TITLE)).toBeTruthy();
    expect(screen.queryByText(FMU_INPUTS_TITLE)).toBeNull();
    // Standalone (no CONNECT) → hint; freshly parsed extras → no re-attach hint.
    expect(screen.getByTestId('fmu-param-standalone-hint')).toBeTruthy();
    expect(screen.queryByTestId('fmu-param-rerange-hint')).toBeNull();
    m.doc.dispose();
  });

  it('Feedthrough: no String row, no output row, no calculatedParameter row; inputs grouped', async () => {
    const m = await mount('feedthrough', (p) => ({
      ...p,
      description: {
        ...p.description,
        variables: [...p.description.variables,
          { name: 'calc', valueReference: 90, causality: 'calculatedParameter', variability: 'fixed', type: 'Real' }],
      },
    }));
    for (const n of ['Float64_fixed_parameter', 'Float64_tunable_parameter', 'Float64_continuous_input', 'Int32_input', 'Boolean_input', 'Enumeration_input']) {
      expect(screen.getByTestId(`fmu-param-row-${n}`)).toBeTruthy();
    }
    for (const n of ['String_input', 'Float64_continuous_output', 'Int32_output', 'calc']) {
      expect(screen.queryByTestId(`fmu-param-row-${n}`)).toBeNull();
    }
    expect(screen.getByText(FMU_INPUTS_TITLE)).toBeTruthy();
    m.doc.dispose();
  });
});

describe('Fmu.FmuVariables renderer — live rows', () => {
  it('a number commit writes the signal (SignalStore.set) and marks the row as changed (ring dot)', async () => {
    const m = await mount('ball');
    expect(m.env.store.get('Ball.e')).toBe(0.7);
    expect(screen.queryByTestId('fmu-param-changed-e')).toBeNull();
    fireEvent.change(numberInput('e'), { target: { value: '0.9' } });
    expect(m.env.store.get('Ball.e')).toBe(0.9);
    expect(screen.getByTestId('fmu-param-changed-e')).toBeTruthy();
    // No document op for a live edit.
    expect(m.rec.ops).toEqual([]);
    m.doc.dispose();
  });

  it('clamps e to 0.5–1 on commit', async () => {
    const m = await mount('ball');
    fireEvent.change(numberInput('e'), { target: { value: '3' } });
    fireEvent.blur(numberInput('e'));
    expect(m.env.store.get('Ball.e')).toBe(1);
    fireEvent.change(numberInput('e'), { target: { value: '0.1' } });
    fireEvent.keyDown(numberInput('e'), { key: 'Enter' });
    expect(m.env.store.get('Ball.e')).toBe(0.5);
    m.doc.dispose();
  });

  it('the enumeration dropdown shows the item names and writes the value', async () => {
    const m = await mount('feedthrough');
    const row = screen.getByTestId('fmu-param-row-Enumeration_input');
    expect(within(row).getByText('Option 1')).toBeTruthy();
    fireEvent.mouseDown(within(row).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Option 2' }));
    expect(m.env.store.get('Panel.Enumeration_input')).toBe(2);
    m.doc.dispose();
  });

  it('"Save as start value" stores the live value as override (Undo removes it)', async () => {
    const m = await mount('ball');
    fireEvent.change(numberInput('e'), { target: { value: '0.95' } });
    tick();
    fireEvent.click(screen.getByTestId('fmu-param-save-e'));
    await settle(m.doc);
    expect(m.rec.ops).toEqual([{ kind: 'setField', fieldName: 'FmuStartOverrides', value: { e: '0.95' } }]);
    expect(m.fmu().startOverrides).toEqual({ e: '0.95' });
    expect(screen.getByTestId('fmu-param-override-e')).toBeTruthy();
    // The live value now equals the effective start → no "changed" marker.
    expect(screen.queryByTestId('fmu-param-changed-e')).toBeNull();

    await act(async () => { await m.doc.undo(); });
    expect(m.fmu().startOverrides).toEqual({});
    expect(screen.queryByTestId('fmu-param-override-e')).toBeNull();
    m.doc.dispose();
  });

  it('the override dot ("Reset to start value") removes the override and writes the modelDescription start live', async () => {
    const m = await mount('ball');
    fireEvent.change(numberInput('e'), { target: { value: '0.95' } });
    tick();
    fireEvent.click(screen.getByTestId('fmu-param-save-e'));
    await settle(m.doc);
    tick();
    fireEvent.click(screen.getByTestId('fmu-param-reset-e'));
    await settle(m.doc);
    expect(m.fmu().startOverrides).toEqual({});
    expect(m.rec.ops.at(-1)).toEqual({ kind: 'unsetField', fieldName: 'FmuStartOverrides' });
    expect(m.env.store.get('Ball.e')).toBe(0.7);
    expect(screen.queryByTestId('fmu-param-override-e')).toBeNull();
    m.doc.dispose();
  });

  it('AllowViewerToFmu=false → live editors locked with a hint, "Save as start value" still possible', async () => {
    const m = await mount('ball');
    tick();
    m.rec.target.setField(m.nodePath, 'Fmu', 'AllowViewerToFmu', false, true);
    await settle(m.doc);
    expect(m.fmu().AllowViewerToFmu).toBe(false);
    expect(screen.getByTestId('fmu-param-locked-hint').textContent).toContain('AllowViewerToFmu');
    expect(numberInput('e').disabled).toBe(true);
    const save = screen.getByTestId('fmu-param-save-e') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    tick();
    fireEvent.click(save);
    await settle(m.doc);
    expect(m.fmu().startOverrides).toEqual({ e: '0.7' });
    m.doc.dispose();
  });
});

describe('Fmu.FmuVariables renderer — fixed parameters, conflicts, old extras', () => {
  it('fixed g: a local draft (no live write, no op while editing); the button writes exactly ONE op', async () => {
    const m = await mount('ball');
    const changes: FmuOverridesChange[] = [];
    const off = subscribeFmuOverridesChanged((_f, c) => changes.push(c));
    try {
      expect(screen.getByTestId('fmu-param-restart-hint-g').textContent).toContain(FMU_RESTART_HINT);
      // A "3-s drag" and keyboard edits: many editor commits, all into the draft.
      for (const v of ['-9', '-7.5', '-5', '-4', '-3.5', '-3']) {
        fireEvent.change(numberInput('g'), { target: { value: v } });
      }
      fireEvent.blur(numberInput('g'));
      expect(m.rec.ops).toEqual([]);
      expect(m.env.store.get('Ball.g')).toBeUndefined(); // a fixed parameter has no signal
      expect(screen.getByTestId('fmu-param-changed-g')).toBeTruthy();

      tick();
      fireEvent.click(screen.getByTestId('fmu-param-save-g'));
      await settle(m.doc);
      expect(m.rec.ops).toEqual([{ kind: 'setField', fieldName: 'FmuStartOverrides', value: { g: '-3' } }]);
      expect(m.fmu().startOverrides).toEqual({ g: '-3' });
      expect(changes).toEqual([{ restartRequired: ['g'], live: [] }]);
      expect(screen.getByTestId('fmu-param-override-g')).toBeTruthy();
      expect(numberInput('g').value).toBe('-3');

      // Undo re-syncs the draft to the modelDescription start.
      await act(async () => { await m.doc.undo(); });
      expect(numberInput('g').value).toBe('-9.81');
    } finally {
      off();
      m.doc.dispose();
    }
  });

  it('an orphaned override is a conflict row; "Remove" removes it from the map', async () => {
    const m = await mount('ball');
    tick();
    m.rec.target.setField(m.nodePath, 'Fmu', 'FmuStartOverrides', { e: '0.8', gravity: '-3' }, undefined);
    await settle(m.doc);
    expect(m.fmu().startOverrides).toEqual({ e: '0.8' });
    const row = screen.getByTestId('fmu-param-orphan-gravity');
    expect(row.textContent).toContain('gravity');
    expect(row.textContent).toContain('= -3');
    expect(row.textContent).toContain('no variable of this name');
    tick();
    fireEvent.click(screen.getByTestId('fmu-param-orphan-remove-gravity'));
    await settle(m.doc);
    expect(m.fmu().FmuStartOverrides).toEqual({ e: '0.8' });
    expect(screen.queryByTestId('fmu-param-orphan-gravity')).toBeNull();
    m.doc.dispose();
  });

  it('old extras without min/max: no clamp, hint "Re-attach the FMU"', async () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    const root = new Object3D(); root.name = 'Model'; scene.add(root);
    const node = new Object3D(); node.name = 'Ball'; root.add(node);
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);
    const sha = 'e'.repeat(64);
    binaryResources.put(sha, new Uint8Array([1]), 'doc');
    const data = {
      FmuEmbed: { fileName: 'BouncingBall.fmu', sha256: sha, guid: '{g}', modelName: 'BouncingBall', fmiVersion: '2.0', byteLength: 1, bufferView: -1 },
      FmuVariables: [{ name: 'e', valueReference: 6, causality: 'parameter', variability: 'tunable', type: 'Real', start: '0.7' }],
    };
    node.userData.realvirtual = { Fmu: data };
    const fmu = new RVFmu(node);
    applySchema(fmu as unknown as Record<string, unknown>, RVFmu.schema, data);
    fmu.init({ registry, signalStore: store, scene } as unknown as ComponentContext);
    const viewer = { registry, signalStore: store } as unknown as RVViewer;
    render(<Renderer value={[]} fieldName="FmuVariables" componentType="Fmu" nodePath={path} viewer={viewer} signalStore={store} />);
    expect(screen.getByTestId('fmu-param-rerange-hint').textContent).toContain(FMU_RERANGE_HINT);
    expect(within(screen.getByTestId('fmu-param-row-e')).queryByTestId('rv-number-range')).toBeNull();
    fireEvent.change(numberInput('e'), { target: { value: '3' } });
    fireEvent.blur(numberInput('e'));
    expect(store.get('Ball.e')).toBe(3);
    fmu.dispose();
  });

  it('no standalone hint once the instance runs in CONNECT', async () => {
    const m = await mount('ball');
    expect(screen.getByTestId('fmu-param-standalone-hint')).toBeTruthy();
    act(() => { m.fmu().setState('running'); });
    expect(screen.queryByTestId('fmu-param-standalone-hint')).toBeNull();
    m.doc.dispose();
  });
});

// ─── plan-510 §9.3 / §9.9 — one value column, the override dot, messages ──

/** The field cell of an InspectorRow grid (children: gutter · label · field). */
function fieldCellOf(rowTestId: string): HTMLElement {
  const grid = screen.getByTestId(rowTestId).firstElementChild as HTMLElement;
  return grid.children[2] as HTMLElement;
}

function referenceFieldLeft(): number {
  render(<InspectorRow label="Reference"><input data-testid="ref-field" /></InspectorRow>);
  return (screen.getByTestId('ref-field').parentElement as HTMLElement).getBoundingClientRect().left;
}

describe('FMU section layout (plan-510 A1)', () => {
  it('every parameter row, hint row and the package summary share the value column of a standard InspectorRow', async () => {
    const m = await mount('ball');
    const ref = referenceFieldLeft();
    for (const id of ['fmu-param-row-e', 'fmu-param-row-g']) {
      expect(Math.abs(fieldCellOf(id).getBoundingClientRect().left - ref), id).toBeLessThanOrEqual(1);
    }
    const hint = screen.getByTestId('fmu-param-standalone-hint');
    expect(Math.abs(hint.getBoundingClientRect().left - ref)).toBeLessThanOrEqual(1);
    const summary = screen.getByText(/BouncingBall · /);
    expect(Math.abs(summary.getBoundingClientRect().left - ref)).toBeLessThanOrEqual(1);
    m.doc.dispose();
  });

  it('the Runtime rows of the FmuEmbed renderer use the same value column', async () => {
    const m = await mount('ball');
    const Embed = fieldRendererRegistry.getRenderer('Fmu', 'FmuEmbed')!;
    render(<Embed value={m.fmu().FmuEmbed} fieldName="FmuEmbed" componentType="Fmu" nodePath={m.nodePath} viewer={m.env.viewer} signalStore={m.env.store} />);
    const ref = referenceFieldLeft();
    const chipCell = screen.getByTestId('fmu-state-chip').parentElement as HTMLElement;
    expect(Math.abs(chipCell.getBoundingClientRect().left - ref)).toBeLessThanOrEqual(1);
    expect(screen.queryByText(/Step \/ Tol/)).toBeNull();
    m.doc.dispose();
  });

  it('package details are collapsed; opening shows GUID and SHA-256 (full value on the copy target)', async () => {
    const m = await mount('ball');
    expect(screen.queryByTestId('fmu-embed-sha')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Package details/ }));
    expect(screen.getByTestId('fmu-embed-sha').getAttribute('data-full')).toBe(m.fmu().embed!.sha256);
    expect(screen.getByTestId('fmu-embed-sha').textContent).toMatch(/^[0-9a-f]{8}…[0-9a-f]{4}$/);
    expect(screen.getByTestId('fmu-embed-guid')).toBeTruthy();
    m.doc.dispose();
  });

  it('a long lastError wraps in the value column of a 320-px inspector, no horizontal scrollbar', async () => {
    const m = await mount('ball');
    cleanup();
    const Embed = fieldRendererRegistry.getRenderer('Fmu', 'FmuEmbed')!;
    render(
      <div data-testid="inspector" style={{ width: 320, overflow: 'auto' }}>
        <Embed value={m.fmu().FmuEmbed} fieldName="FmuEmbed" componentType="Fmu" nodePath={m.nodePath} viewer={m.env.viewer} signalStore={m.env.store} />
      </div>,
    );
    const long = 'CONNECT refused the start-value overrides — g = abc: not a number; e = 7: above the maximum 1. '.repeat(3)
      + 'AVeryLongUnbreakableTokenWithoutAnySpacesThatMustStillWrapInsideTheValueColumn';
    act(() => { m.fmu().setState('error', long); });
    const msg = screen.getByTestId('fmu-last-error');
    expect(msg.textContent).toBe(long);
    const box = screen.getByTestId('inspector');
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    expect(msg.getBoundingClientRect().height).toBeGreaterThan(30); // wrapped over several lines
    m.doc.dispose();
  });
});

describe('FMU override dot (plan-510 §9.9)', () => {
  it('live value differs, no override → ring dot; a click writes the start live', async () => {
    const m = await mount('ball');
    expect(screen.queryByTestId('fmu-param-reset-e')).toBeNull();
    fireEvent.change(numberInput('e'), { target: { value: '0.9' } });
    const dot = screen.getByTestId('fmu-param-reset-e');
    expect(dot.getAttribute('data-state')).toBe('changed');
    expect(screen.getByTestId('fmu-param-changed-e')).toBeTruthy();
    fireEvent.click(dot);
    expect(m.env.store.get('Ball.e')).toBe(0.7);
    expect(screen.queryByTestId('fmu-param-reset-e')).toBeNull();
    expect(m.rec.ops).toEqual([]); // nothing stored → nothing to remove
    m.doc.dispose();
  });

  it('local draft differs, no override → a click resets the draft', async () => {
    const m = await mount('ball');
    fireEvent.change(numberInput('g'), { target: { value: '-3' } });
    fireEvent.blur(numberInput('g'));
    expect(screen.getByTestId('fmu-param-reset-g').getAttribute('data-state')).toBe('changed');
    fireEvent.click(screen.getByTestId('fmu-param-reset-g'));
    expect(numberInput('g').value).toBe('-9.81');
    expect(screen.queryByTestId('fmu-param-reset-g')).toBeNull();
    m.doc.dispose();
  });

  it('override stored AND value equals the start → filled dot; a click removes the override', async () => {
    const m = await mount('ball');
    tick();
    m.rec.target.setField(m.nodePath, 'Fmu', 'FmuStartOverrides', { e: '0.7' }, undefined);
    await settle(m.doc);
    expect(m.env.store.get('Ball.e')).toBe(0.7);
    const dot = screen.getByTestId('fmu-param-reset-e');
    expect(dot.getAttribute('data-state')).toBe('override');
    expect(screen.getByTestId('fmu-param-override-e')).toBeTruthy();
    tick();
    fireEvent.click(dot);
    await settle(m.doc);
    expect(m.fmu().startOverrides).toEqual({});
    expect(screen.queryByTestId('fmu-param-reset-e')).toBeNull();
    m.doc.dispose();
  });

  it('override stored AND live value differs → a click removes the override and writes the start live', async () => {
    const m = await mount('ball');
    tick();
    m.rec.target.setField(m.nodePath, 'Fmu', 'FmuStartOverrides', { e: '0.8' }, undefined);
    await settle(m.doc);
    fireEvent.change(numberInput('e'), { target: { value: '0.95' } });
    expect(screen.getByTestId('fmu-param-reset-e').getAttribute('data-state')).toBe('override');
    tick();
    fireEvent.click(screen.getByTestId('fmu-param-reset-e'));
    await settle(m.doc);
    expect(m.fmu().startOverrides).toEqual({});
    expect(m.env.store.get('Ball.e')).toBe(0.7);
    m.doc.dispose();
  });

  it('a comma decimal typed into a parameter keeps its fraction (A5)', async () => {
    const m = await mount('ball');
    fireEvent.change(numberInput('g'), { target: { value: '-9,5' } });
    fireEvent.blur(numberInput('g'));
    expect(numberInput('g').value).toBe('-9.5');
    fireEvent.change(numberInput('e'), { target: { value: '0,85' } });
    expect(m.env.store.get('Ball.e')).toBe(0.85);
    m.doc.dispose();
  });

  it('the section is English: no German UI text is rendered', async () => {
    const m = await mount('feedthrough');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/[äöüÄÖÜß]/);
    expect(text).not.toMatch(/\b(Entfernen|Konflikte|Startwert|Neustart|Keine)\b/);
    m.doc.dispose();
  });
});
