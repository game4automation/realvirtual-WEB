// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.7 (Phase 1 part, without CONNECT) — the FMU in the HMI:
 * hierarchy rows (badge types, signal children), live value at a child,
 * Standalone problems, the inspector renderer (sourced from the registry, the
 * production path) and the editor context-menu action "Attach FMU…".
 * plan-510: the section reads Runtime → Parameters → Package details; the
 * state is also the section-header value (`getPrimaryDisplayValue`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import appSource from '../src/core/hmi/App.tsx?raw';
import feedthroughUrl from './fixtures/Feedthrough.fmu?url';
import '../src/core/hmi/FmuAttachAction';
import '../src/core/hmi/rv-fmu-parameters-field-renderer';
import { FMU_ATTACH_LABEL, FMU_DETACH_LABEL, FMU_PACKAGE_DETAILS_TITLE, runAttachFmu } from '../src/core/hmi/FmuAttachAction';
import { getPrimaryDisplayValue } from '../src/core/hmi/rv-value-resolver';
import { getSignalHeaderColor } from '../src/core/hmi/rv-inspector-helpers';
import { fieldRendererRegistry } from '../src/core/hmi/rv-field-renderer-registry';
import { componentActionRegistry } from '../src/core/hmi/rv-component-action-registry';
import { contextMenuStore } from '../src/core/hmi/context-menu-store';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import { isFieldHidden } from '../src/core/hmi/rv-inspector-helpers';
import { sceneRow } from '../src/core/hmi/hierarchy-rows';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { getFilterableTypes, uiOf } from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import { fmuOf, getFmuInstances, FMU_STATE_COLORS, FMU_TYPE } from '../src/core/engine/rv-fmu';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { FmuTrustDialog, FMU_TRUST_WARNING, FMU_TRUST_CONFIRM_LABEL, FMU_TRUST_CANCEL_LABEL } from '../src/core/hmi/FmuTrustDialog';
import { requestFmuTrust, getFmuTrustRequests, resetFmuTrustForTests, type FmuTrustRequest } from '../src/core/hmi/fmu-trust-store';
import { FMU_TRUST_START_LABEL, FMU_STOP_LABEL, FMU_REPROVISION_LABEL } from '../src/core/hmi/FmuAttachAction';
import { FmuProvisioningPlugin } from '../src/plugins/fmu-provisioning-plugin';
import { NodeBadges } from '../src/core/hmi/hierarchy-badge-components';
import type { ConnectFmuApi } from '../src/core/hmi/connect-fmu';

interface World {
  viewer: RVViewer;
  model: Group;
  registry: NodeRegistry;
  store: SignalStore;
}

function world(): World {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  for (const n of ['Hydraulics', 'Panel']) {
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
  return { viewer, model, registry, store };
}

async function feedthroughFile(): Promise<File> {
  const bytes = await (await fetch(feedthroughUrl)).arrayBuffer();
  return new File([bytes], 'Feedthrough.fmu');
}

let w: World;
let doc: ReturnType<typeof scratchAssetDocument>;

beforeEach(() => {
  binaryResources._resetForTesting();
  resetProblemsForTests();
  for (const i of [...getFmuInstances()]) i.dispose();
  w = world();
  doc = scratchAssetDocument(w.viewer);
  setActiveAssetContext({ viewer: w.viewer, doc });
});

afterEach(() => {
  cleanup();
  contextMenuStore.close();
  setActiveAssetContext(null);
  doc.dispose();
});

describe('FMU in the HMI', () => {
  it('App.tsx side-effect-imports the FMU HMI module (else nothing registers in production)', () => {
    expect(appSource).toContain("import './FmuAttachAction';");
    expect(fieldRendererRegistry.getRenderer('Fmu', 'FmuEmbed')).toBeTruthy();
    expect(componentActionRegistry.get('Fmu').map((a) => a.id)).toEqual(['fmu-attach']);
    expect(componentActionRegistry.get('Fmu')[0].placement).toBe('menu');
    expect(tooltipRegistry.getDataResolver('fmu')).toBeTruthy();
  });

  it('badge / filter / tooltip come from the ui capabilities; FmuVariables has its renderer, the override map is no raw row', () => {
    expect(uiOf('Fmu').filter).toBe('FMU');
    expect(uiOf('Fmu').tooltip).toBe('fmu');
    expect(uiOf('Fmu').badge).toBe('#ab47bc');
    expect(getFilterableTypes()).toContain('Fmu');
    // plan-502: FmuVariables is rendered by the parameters renderer (a hidden field never reaches it).
    expect(isFieldHidden('Fmu', 'FmuVariables')).toBe(false);
    expect(isFieldHidden('Fmu', 'FmuStartOverrides')).toBe(true);
    expect(isFieldHidden('Fmu', 'FmuEmbed')).toBe(false);
  });

  it('context menu "Attach FMU…" attaches through the document; the node gets its badge and signal children', async () => {
    const hyd = w.model.getObjectByName('Hydraulics')!;
    const path = NodeRegistry.computeNodePath(hyd);
    contextMenuStore.open({ x: 0, y: 0 }, { path, node: hyd, types: [], extras: {} });
    const labels = contextMenuStore.getSnapshot().items.map((i) => i.resolvedLabel);
    expect(labels).toContain(FMU_ATTACH_LABEL);
    expect(labels).not.toContain(FMU_DETACH_LABEL);
    contextMenuStore.close();

    expect(await runAttachFmu(path, await feedthroughFile())).toBe(true);
    const fmu = fmuOf(hyd)!;
    expect(fmu.state).toBe('standalone');

    // Hierarchy rows: the FMU node carries the `Fmu` type (→ badge), its
    // signal children are addressable document rows, not runtime rows.
    const ctx = { getPathForNode: (n: Object3D) => w.registry.getPathForNode(n), overlay: null, modelRoot: w.model };
    expect(sceneRow(hyd, ctx as never).types).toContain('Fmu');
    const signals = hyd.children.find((c) => c.name === 'Signals')!;
    expect(sceneRow(signals, ctx as never).runtime).toBe(false);
    const leaf = signals.children.find((c) => c.name === 'Float64_continuous_output')!;
    const leafRow = sceneRow(leaf, ctx as never);
    expect(leafRow.types).toContain('PLCOutputFloat');
    expect(leafRow.runtime).toBe(false);

    // A live value at the child (what the WS adapter writes in Phase 3).
    w.store.set('Hydraulics.Float64_continuous_output', 12.4);
    expect(w.store.getByPath(`${path}/Signals/Float64_continuous_output`)).toBe(12.4);

    // Now the menu offers removal instead.
    contextMenuStore.open({ x: 0, y: 0 }, { path, node: hyd, types: ['Fmu'], extras: {} });
    const after = contextMenuStore.getSnapshot().items.map((i) => i.resolvedLabel);
    expect(after).toContain(FMU_DETACH_LABEL);
    expect(after).not.toContain(FMU_ATTACH_LABEL);
  });

  it('no editor document → no FMU menu entries', () => {
    setActiveAssetContext(null);
    const hyd = w.model.getObjectByName('Hydraulics')!;
    contextMenuStore.open({ x: 0, y: 0 }, { path: 'Asset/Hydraulics', node: hyd, types: [], extras: {} });
    const labels = contextMenuStore.getSnapshot().items.map((i) => i.resolvedLabel);
    expect(labels).not.toContain(FMU_ATTACH_LABEL);
  });

  it('Standalone problems + the inspector renderers (runtime + collapsed package details + unsupported variables)', async () => {
    const hyd = w.model.getObjectByName('Hydraulics')!;
    const path = NodeRegistry.computeNodePath(hyd);
    await runAttachFmu(path, await feedthroughFile());

    const problems = getProblems();
    expect(problems.find((p) => p.code === 'fmu-not-runnable')?.severity).toBe('info');
    expect(problems.find((p) => p.code === 'fmu-variable-unsupported')?.detail).toContain('String_input (String)');

    const Renderer = fieldRendererRegistry.getRenderer('Fmu', 'FmuEmbed')!;
    const Params = fieldRendererRegistry.getRenderer('Fmu', 'FmuVariables')!;
    const embed = (hyd.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu.FmuEmbed;
    render(
      <>
        <Renderer value={embed} fieldName="FmuEmbed" componentType="Fmu" nodePath={path} viewer={w.viewer} signalStore={w.store} />
        <Params value={[]} fieldName="FmuVariables" componentType="Fmu" nodePath={path} viewer={w.viewer} signalStore={w.store} />
      </>,
    );
    expect(screen.getByTestId('fmu-state-chip').textContent).toContain('standalone');
    expect(screen.getByTestId('fmu-unsupported').textContent).toContain('String_output (String)');
    expect(screen.queryByText(/Step \/ Tol/)).toBeNull();
    // Package details: collapsed, the summary names the model; GUID / SHA only after opening.
    const details = screen.getByTestId('fmu-embed');
    expect(details.getAttribute('data-open')).toBe('false');
    expect(details.textContent).toContain('Feedthrough');
    expect(screen.queryByTestId('fmu-embed-sha')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(FMU_PACKAGE_DETAILS_TITLE) }));
    expect(details.textContent).toContain('Reference FMUs');
    expect(screen.getByTestId('fmu-embed-sha').getAttribute('data-full')).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.getByTestId('fmu-embed-guid')).toBeTruthy();
    // Order: Runtime before the parameters, package details last.
    const all = document.body.textContent ?? '';
    expect(all.indexOf('Runtime')).toBeLessThan(all.indexOf('Parameters'));
    expect(all.indexOf('Parameters')).toBeLessThan(all.indexOf(FMU_PACKAGE_DETAILS_TITLE));
  });

  it('a refused package (FMI 1.0 / garbage) reports fmu-attach-refused and changes nothing', async () => {
    const panel = w.model.getObjectByName('Panel')!;
    const path = NodeRegistry.computeNodePath(panel);
    expect(await runAttachFmu(path, new File([new Uint8Array([1, 2, 3])], 'broken.fmu'))).toBe(false);
    expect(getProblems().some((p) => p.code === 'fmu-attach-refused')).toBe(true);
    expect(fmuOf(panel)).toBeNull();
    expect(doc.getSnapshot().dirty).toBe(false);
  });
});

// ─── Phase 3: consent dialog, lifecycle actions, state badge ──────────────

function trustRequest(sha: string, name: string, nodePath: string): FmuTrustRequest {
  return {
    sha256: sha, modelName: name, guid: `{${name}-guid}`, generationTool: 'Reference FMUs 0.0.40',
    fileName: `${name}.fmu`, byteLength: 42_000, sources: [{ nodePath, instanceKey: `proj/doc#${nodePath}` }],
  };
}

interface Tracked<T> { settled: boolean; value?: T }

/** Promise state without awaiting it. */
function tracked<T>(p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { settled: false };
  void p.then((v) => { t.settled = true; t.value = v; });
  return t;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('FMU consent dialog (plan-498 Phase 3)', () => {
  afterEach(() => { act(() => resetFmuTrustForTests()); });

  it('blocks until a decision: Escape and backdrop do not answer; one row per SHA; only checked packages are trusted', async () => {
    render(<FmuTrustDialog />);
    expect(screen.queryByTestId('fmu-trust-dialog')).toBeNull();

    const shaA = 'a'.repeat(64);
    const shaB = 'b'.repeat(64);
    let a1!: Tracked<boolean>;
    let a2!: Tracked<boolean>;
    let b!: Tracked<boolean>;
    act(() => {
      a1 = tracked(requestFmuTrust(trustRequest(shaA, 'Feedthrough', 'Cell_1/Hyd')));
      a2 = tracked(requestFmuTrust(trustRequest(shaA, 'Feedthrough', 'Cell_2/Hyd')));
      b = tracked(requestFmuTrust(trustRequest(shaB, 'BouncingBall', 'Ball')));
    });

    const dialog = screen.getByTestId('fmu-trust-dialog');
    expect(screen.getByTestId('fmu-trust-warning').textContent).toBe(FMU_TRUST_WARNING);
    const rows = screen.getAllByTestId('fmu-trust-row');
    expect(rows).toHaveLength(2);
    // Same SHA twice → one row with both sources.
    expect(rows[0].textContent).toContain('Cell_1/Hyd');
    expect(rows[0].textContent).toContain('Cell_2/Hyd');
    expect(rows[0].textContent).toContain('{Feedthrough-guid}');
    expect(rows[0].textContent).toContain('Reference FMUs 0.0.40');
    expect(rows[0].textContent).toContain('Feedthrough.fmu · 41.0 kB');
    expect(screen.getAllByTestId('fmu-trust-sha')[0].textContent).toBe('aaaaaaaa…aaaa');
    expect(screen.queryByText(/always trust/i)).toBeNull();

    // Not an answer: Escape, backdrop click.
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    const backdrop = document.querySelector('.MuiBackdrop-root');
    if (backdrop) fireEvent.click(backdrop);
    await flush();
    expect(a1.settled || a2.settled || b.settled).toBe(false);
    expect(getFmuTrustRequests()).toHaveLength(2);

    // Uncheck BouncingBall, confirm.
    fireEvent.click(screen.getByLabelText('Trust BouncingBall'));
    fireEvent.click(screen.getByText(FMU_TRUST_CONFIRM_LABEL));
    await flush();
    expect([a1.value, a2.value, b.value]).toEqual([true, true, false]);
    expect(screen.queryByTestId('fmu-trust-dialog')).toBeNull();
  });

  it('"Cancel" answers every open question with no', async () => {
    render(<FmuTrustDialog />);
    let q!: Tracked<boolean>;
    act(() => { q = tracked(requestFmuTrust(trustRequest('c'.repeat(64), 'M', 'Hyd'))); });
    fireEvent.click(screen.getByText(FMU_TRUST_CANCEL_LABEL));
    await flush();
    expect(q).toEqual({ settled: true, value: false });
  });
});

describe('FMU lifecycle actions + state badge (plan-498 Phase 3)', () => {
  const failCreate = { value: false };

  function fakeApi(trusted: boolean, calls: string[]): ConnectFmuApi {
    return {
      getPackage: async (sha) => ({ sha256: sha, trusted, refCount: 0, meta: { modelName: 'Feedthrough', guid: '', fmiVersion: '2.0', byteLength: 1 }, variables: [] }),
      uploadPackage: async () => { throw new Error('unused'); },
      trust: async () => { calls.push('trust'); },
      revokeTrust: async () => {},
      createInstance: async () => {
        if (failCreate.value) throw new Error('instance refused by the test');
        calls.push('instance');
        return { interfaceId: 'fmu-1', leaseId: 'L1', created: true };
      },
      renewLease: async (id) => ({ leaseId: id, interfaceId: 'fmu-1' }),
      releaseLease: async (id) => { calls.push(`release ${id}`); },
      fetchWorkerStatuses: async () => ({ 'fmu-1': { status: 'Connected' } }),
    };
  }

  function connectViewer(): RVViewer {
    return {
      ...w.viewer,
      on: () => () => {},
      getPlugin: (id: string) => (id === 'connect'
        ? { id, streamEndpoint: new URL('ws://127.0.0.1:5100/ws'), streamConnectionState: 'connected' }
        : undefined),
    } as unknown as RVViewer;
  }

  it('needs-trust shows "Trust & start"; a lease shows Stop + Re-provision; Stop releases the lease; the header follows the state', async () => {
    const hyd = w.model.getObjectByName('Hydraulics')!;
    const path = NodeRegistry.computeNodePath(hyd);
    await runAttachFmu(path, await feedthroughFile());
    const fmu = fmuOf(hyd)!;
    const calls: string[] = [];
    const asked: string[] = [];
    let answer = false;
    const plugin = new FmuProvisioningPlugin({
      api: fakeApi(false, calls), gatewayUrl: () => 'http://127.0.0.1:5100', subscribeGateway: () => () => {},
      confirmTrust: async (r) => { asked.push(r.sha256); return answer; },
      renewIntervalMs: 3_600_000, statusIntervalMs: 3_600_000,
    });
    plugin.init(connectViewer());
    try {
      await flush();
      expect(fmu.state).toBe('needs-trust');
      const Renderer = fieldRendererRegistry.getRenderer('Fmu', 'FmuEmbed')!;
      const embed = (hyd.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu.FmuEmbed;
      render(<Renderer value={embed} fieldName="FmuEmbed" componentType="Fmu" nodePath={path} viewer={w.viewer} signalStore={w.store} />);
      expect(screen.getByTestId('fmu-state-chip').textContent).toContain('needs trust');
      expect(screen.queryByText(FMU_STOP_LABEL)).toBeNull();

      answer = true;
      fireEvent.click(screen.getByText(FMU_TRUST_START_LABEL));
      await flush();
      expect(asked).toHaveLength(2);
      expect(calls).toEqual(['trust', 'instance']);
      expect(fmu.state).toBe('running');
      expect(screen.getByTestId('fmu-state-chip').textContent).toContain('running');
      // plan-510 §9.9: the section header shows the state, in its state colour, through the real Fmu entry.
      const header = getPrimaryDisplayValue(w.viewer, path, FMU_TYPE, {});
      expect(header.text).toBe('running');
      expect(getSignalHeaderColor(FMU_TYPE, header.text!)).toBe(FMU_STATE_COLORS.running);
      expect(screen.queryByText(FMU_TRUST_START_LABEL)).toBeNull();
      expect(screen.getByText(FMU_REPROVISION_LABEL)).toBeTruthy();

      fireEvent.click(screen.getByText(FMU_STOP_LABEL));
      await flush();
      expect(calls).toContain('release L1');
      expect(fmu.state).toBe('idle');
      expect(screen.queryByText(FMU_STOP_LABEL)).toBeNull();
      expect(getPrimaryDisplayValue(w.viewer, path, FMU_TYPE, {}).text).toBe('idle');
      expect(getSignalHeaderColor(FMU_TYPE, 'idle')).toBe(FMU_STATE_COLORS.idle);

      // A real failure: CONNECT refuses the next instance → the plugin's error transition.
      failCreate.value = true;
      fireEvent.click(screen.getByText(FMU_REPROVISION_LABEL));
      await flush();
      expect(fmu.state).toBe('error');
      expect(getPrimaryDisplayValue(w.viewer, path, FMU_TYPE, {}).text).toBe('error');
      expect(getSignalHeaderColor(FMU_TYPE, 'error')).toBe(FMU_STATE_COLORS.error);
      expect(screen.getByTestId('fmu-last-error').textContent).toContain('refused');
    } finally {
      failCreate.value = false;
      plugin.dispose();
    }
  });

  it('the hierarchy badge of an Fmu node is painted in its state colour', async () => {
    const hyd = w.model.getObjectByName('Hydraulics')!;
    const path = NodeRegistry.computeNodePath(hyd);
    await runAttachFmu(path, await feedthroughFile());
    const fmu = fmuOf(hyd)!;
    render(<NodeBadges types={['Fmu']} signalStore={w.store} path={path} stepInfo={null} viewer={w.viewer} />);
    const chip = screen.getByText('FMU').closest('.MuiChip-root') as HTMLElement;
    expect(getComputedStyle(chip).color).toContain('144, 164, 174'); // standalone grey
    act(() => fmu.setState('running'));
    expect(getComputedStyle(chip).color).toContain('102, 187, 106'); // running green
    act(() => fmu.setState('error', 'boom'));
    expect(getComputedStyle(chip).color).toContain('239, 83, 80'); // error red
  });
});
