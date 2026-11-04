// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * web-operator-panel-late-signals.test.ts — a model-borne operator panel binds
 * itself when a LAZY feature registers its signals seconds later (plan-673 O20).
 *
 * ## The defect
 *
 * Binding used to be one synchronous check on `model-loaded`, and the host
 * never rebuilds an unchanged component. A feature whose signals arrive later —
 * the MuJoCo walker's interface lands after 8.2 MB of WASM, measured 8-17 s
 * cold — therefore met an empty store, and the plate came up with thirteen
 * "not found in model" complaints and stayed dead for the rest of the session.
 * The only thing that saved it was the plugin remembering to call
 * `webOperatorPanels.reset()` itself, which is not a contract.
 *
 * ## How this is tested, and the three traps avoided
 *
 *  1. **Through the productive path.** `viewer.loadModel` → `loadGLB` →
 *     `prepareAndBake` → `bakeRegistry`. A test on the authoring tree is green
 *     and blind: nodes that survive authoring need not survive the bake.
 *  2. **No wall clock anywhere.** The ordering is forced by a `Deferred` the
 *     test holds: the fake feature registers its signals only when the test
 *     resolves it. Nothing here asserts a duration, and nothing waits on one.
 *  3. **The oracle must not be the subject.** `pending` is read from the
 *     PUBLISHED host entry, never from `validateOperatorPanelConfig` or
 *     `controller.getSnapshot()` — those are the very functions that compute
 *     it. And "usable again" is measured as an EFFECT: a panel write has to
 *     land in the SignalStore.
 *
 * Deliberately NOT asserted on rendered DOM of `OperatorPanel.tsx` /
 * `SelectorSwitch.tsx`: those files are being reworked elsewhere (generic panel
 * layout), and a DOM assertion would couple this regression to their markup.
 * The published entry is the seam between the model and whatever draws it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import {
  WEB_OPERATOR_PANEL_PROBLEM, type WebOperatorPanelEntry,
} from '../src/core/engine/rv-web-operator-panel';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import type { RVViewer } from '../src/core/rv-viewer';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  clearAllProblems();
});

/** A promise the TEST resolves — the only thing that orders this scenario. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let queued microtasks and the host's coalesced rescan run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** A panel naming three signals NO model node declares — a feature brings them. */
const PANEL = (signals: readonly string[]) => ({
  version: 1,
  id: 'late-panel',
  title: 'Late panel',
  columns: 2,
  buttons: [{
    label: 'Start', legend: 'Start', capColor: 'green',
    signal: signals[0], lamp: { signal: signals[1], color: 'green' }, row: 1, col: 1,
  }],
  selectors: [{
    label: 'Mode', caption: 'Mode', variant: 'knob', signal: signals[2],
    positions: [{ legend: 'Off', value: false }, { legend: 'On', value: true }],
    row: 1, col: 2,
  }],
  estops: [],
  stackLight: [],
  status: [{ kind: 'idle', tone: 'neutral', text: 'READY' }],
});

const LATE = ['Late_Start', 'Late_Running', 'Late_Mode'] as const;

async function fixtureGlb(signals: readonly string[]): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'LateStation';
  const frame = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x888888 }));
  frame.name = 'Frame';
  root.add(frame);
  const panel = new Object3D();
  panel.name = 'OperatorPanel';
  panel.userData.realvirtual = {
    WebOperatorPanel: {
      Title: 'Late panel',
      Config: JSON.stringify(PANEL(signals)),
      Dock: 'top-left',
      StartCollapsed: false,
    },
  };
  root.add(panel);
  return objectToGlb(sceneMirroringLoad(root));
}

/**
 * A feature exactly like `mujoco.register.ts`: declared up front, activated by
 * a probe on `model-loaded`, and its body registers the signal interface — but
 * only once `gate` resolves. Returns the spy log.
 */
function installLateFeature(
  viewer: RVViewer,
  signals: readonly string[],
  gate: Promise<void>,
  log: string[],
): void {
  const id = 'late-signals-fixture';
  viewer.features.define({
    id,
    label: 'Fixture physics',
    activation: ['intent'],
    origin: 'commercial',
    load: () => Promise.resolve({
      activate: async () => {
        await gate;
        // Logged BEFORE the loop on purpose: the last `register()` call is what
        // rebinds the panel, synchronously, from inside this very loop. Logging
        // after it would put the CONSEQUENCE before the CAUSE and say nothing
        // about the real order.
        log.push('signals-registered');
        const store = viewer.signalStore!;
        for (const name of signals) store.register(name, `Late/PLC/${name}`, false, 'PLCOutputBool');
      },
    }),
  });
  // Registered AFTER the viewer's own `model-loaded` handler (constructor), so
  // the panel binds first — which is the whole situation under test.
  viewer.on('model-loaded', () => {
    void viewer.features.ensure(id, 'intent').catch(() => { /* reported by the loader */ });
  });
}

/** Watch the published entry and log every pending → ready transition. */
function watchEntries(viewer: RVViewer, log: string[]): void {
  let wasPending: boolean | null = null;
  const read = (): void => {
    const e = viewer.webOperatorPanels.entries[0] as WebOperatorPanelEntry | undefined;
    if (!e) return;
    if (wasPending === null) { wasPending = e.pending; log.push(e.pending ? 'panel-bound' : 'panel-ready'); return; }
    if (e.pending === wasPending) return;
    wasPending = e.pending;
    log.push(e.pending ? 'panel-pending' : 'panel-rebound');
  };
  cleanups.push(viewer.webOperatorPanels.subscribe(read));
  read();
}

async function boot(signals: readonly string[], gate: Promise<void>, log: string[]) {
  const bytes = await fixtureGlb(signals);
  const handle: TestViewerHandle = await createTestViewer('webgl');
  cleanups.push(() => handle.dispose());
  const viewer = handle.viewer;
  installLateFeature(viewer, LATE, gate, log);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  cleanups.push(() => URL.revokeObjectURL(url));
  await viewer.loadModel(url);
  await viewer.whenSceneReady();
  watchEntries(viewer, log);
  await settle();
  return viewer;
}

const entryOf = (viewer: RVViewer): WebOperatorPanelEntry => {
  const e = viewer.webOperatorPanels.entries[0];
  expect(e, 'the model produced no operator panel entry').toBeDefined();
  return e;
};

describe('plan-673 O20 — an operator panel waits for late signals and then binds itself', () => {
  it('pending while the feature loads, usable the moment its signals arrive', async () => {
    const gate = deferred();
    const log: string[] = [];
    const viewer = await boot(LATE, gate.promise, log);

    // ── before resolve(): STARTING UP, not broken ──
    const waiting = entryOf(viewer);
    expect(waiting.pending).toBe(true);
    expect(waiting.errors).toHaveLength(1);
    expect(waiting.errors[0]).toMatch(/waiting for 3 signals/i);
    // A write is refused while it is not bound — "disabled" as behaviour.
    waiting.controller.write(LATE[0], true);
    expect(viewer.signalStore!.get(LATE[0])).toBeUndefined();
    // The Problems panel says INFO, so nobody is sent looking for a defect.
    const info = getProblems().filter((p) => p.code === WEB_OPERATOR_PANEL_PROBLEM);
    expect(info).toHaveLength(1);
    expect(info[0].severity).toBe('info');

    // ── resolve(): the feature registers its interface ──
    gate.resolve();
    await viewer.features.ensure('late-signals-fixture', 'intent');
    await settle();

    const bound = entryOf(viewer);
    expect(bound.pending).toBe(false);
    expect(bound.errors).toEqual([]);
    // THE criterion: a panel press lands in the store. Effect, not state.
    bound.controller.write(LATE[0], true);
    expect(viewer.signalStore!.getBool(LATE[0])).toBe(true);
    bound.controller.write(LATE[0], false);
    expect(viewer.signalStore!.getBool(LATE[0])).toBe(false);
    // And the Problems entry is gone, not downgraded.
    expect(getProblems().filter((p) => p.code === WEB_OPERATOR_PANEL_PROBLEM)).toEqual([]);

    // ── the ORDER, asserted as a sequence and never as a duration ──
    expect(log).toEqual(['panel-bound', 'signals-registered', 'panel-rebound']);
  }, 120_000);

  it('a mode switch keeps it bound, and the write path keeps working', async () => {
    const gate = deferred();
    const log: string[] = [];
    const viewer = await boot(LATE, gate.promise, log);
    gate.resolve();
    await viewer.features.ensure('late-signals-fixture', 'intent');
    await settle();
    expect(entryOf(viewer).pending).toBe(false);

    // The mode has to EXIST in this bare viewer — a bare `switchMode` on an
    // unregistered id is refused with a console warning and the test would pass
    // without a mode switch ever happening (an instrument finding, caught by
    // reading the run's output rather than its exit code).
    viewer.modes.register({ id: 'commissioning', label: 'Commissioning' });
    expect(await viewer.modes.switchMode('commissioning')).toBe(true);
    expect(viewer.modes.activeMode).toBe('commissioning');
    await settle();
    const after = entryOf(viewer);
    expect([after.pending, [...after.errors]]).toEqual([false, []]);
    after.controller.write(LATE[2], true);
    expect(viewer.signalStore!.getBool(LATE[2])).toBe(true);
  }, 120_000);

  it('REGRESSION: a signal nobody ever registers is still a visible WARNING', async () => {
    // The thing the pending state must not cost us. One of the three names is
    // never brought by anybody, so once the feature activation has ENDED the
    // verdict falls — on the end of the activation, not on a timeout.
    const gate = deferred();
    const log: string[] = [];
    const bytes = await fixtureGlb(['Late_Start', 'Late_Running', 'Late_Typo']);
    const handle = await createTestViewer('webgl');
    cleanups.push(() => handle.dispose());
    const viewer = handle.viewer;
    installLateFeature(viewer, LATE, gate.promise, log);  // registers LATE, not Late_Typo
    const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
    cleanups.push(() => URL.revokeObjectURL(url));
    await viewer.loadModel(url);
    await viewer.whenSceneReady();
    await settle();
    expect(entryOf(viewer).pending).toBe(true);

    gate.resolve();
    await viewer.features.ensure('late-signals-fixture', 'intent');
    await settle();

    const entry = entryOf(viewer);
    expect(entry.pending).toBe(false);
    // The STRUCTURED field, not a text search: a negative assertion on prose
    // finds this file's own comments (plan-673 lesson).
    const problems = getProblems().filter((p) => p.code === WEB_OPERATOR_PANEL_PROBLEM);
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('warning');
    // And it still names what is wrong, with the JSON path.
    expect(entry.errors.join('; ')).toMatch(/Late_Typo/);
    // Still refused — a half-bound panel would be worse than a dead one.
    entry.controller.write('Late_Start', true);
    expect(viewer.signalStore!.getBool('Late_Start')).toBe(false);
  }, 120_000);
});
