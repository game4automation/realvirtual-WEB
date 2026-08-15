// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * inspector-plc-bind-row — the "Klammer" on a raw PLC signal node
 * (plan-422 F3, test 9.3).
 *
 * plan-418 F6 built the synthetic `Value` bind row so that a signal node's
 * property inspector offers the same link affordance as every component slot.
 * The user's screenshot of `RobotAtConveyorPick` in the demo says it does not
 * arrive there, and this file is where that claim is settled: the first
 * describe reproduces the exact node out of the SHIPPING demo GLB, and the
 * matrix below it pins the row for all six signal types plus the lamp and
 * button slots, so a fix cannot quietly hold for one type only.
 *
 * The negative cases matter as much: without a `SignalBindingManager` there is
 * nothing to bind to, and a read-only surface must say so rather than render a
 * bracket that does nothing.
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Object3D, Scene } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { findSignalBindTarget } from '../src/plugins/signal-bind/signal-bind-target';
import { isPLCSignalComponent, PLCSignalSlot } from '../src/plugins/signal-bind/InlineSignalSlots';
import { SIGNAL_TYPES } from '../src/core/engine/rv-signal-construction';
import { PLC_SIGNAL_SLOT } from '../src/core/engine/rv-binding-slot-resolver';
import type { RVViewer } from '../src/core/rv-viewer';
import '../src/core/engine/rv-lamp';
import '../src/core/engine/rv-push-button3d';

const DEMO_MODEL = '/models/DemoRealvirtualWeb.glb';
/**
 * The node from the user's screenshot, at its path in the shipping demo.
 *
 * It sat under `DemoCell/PLCInterface/…` when the defect was reported; phase 6
 * of this plan re-homed the robot signal groups onto the robot itself, which is
 * where it lives now. The bug it reproduces is unrelated to either location —
 * the inspector lost the row whenever the selected path was spelled as an
 * ALIAS, and this path still is one (the canonical form carries the model-root
 * prefix), which is exactly why the case stays worth testing here.
 */
const SCREENSHOT_NODE = 'Robot/--- Robot Pick and Place Positions ---/RobotAtConveyorPick';

afterEach(cleanup);

// ── Viewer surface the inspector row touches ─────────────────────────────

function makeViewer(result: LoadResult, opts: { manager?: boolean } = {}): RVViewer {
  const manager = opts.manager === false
    ? null
    : new SignalBindingManager(result.signalStore, result.registry);
  return {
    registry: result.registry,
    signalStore: result.signalStore,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
    markRenderDirty: () => {},
  } as unknown as RVViewer;
}

/**
 * The bracket (link) button of a bindable slot row — the affordance F3 is about.
 *
 * Queried by attribute rather than by accessible role+name: the row also
 * renders the bound-signal CHIP as `role="button"` with the near-identical
 * label "change signal for <slot>", so a name matcher hits both and tells us
 * nothing about the bracket specifically.
 */
function bracket(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('button[aria-label^="signal for"]');
}

// ── 1. The reported case, out of the shipping demo GLB ───────────────────

describe('RobotAtConveyorPick in the shipping demo GLB (F3 repro)', () => {
  let load: LoadResult;
  let viewer: RVViewer;

  beforeAll(async () => {
    const scene = new Scene();
    load = await loadGLB(DEMO_MODEL, scene, { loadKinematicsSidecar: false });
    viewer = makeViewer(load);
  }, 120_000);

  it('is a PLCInputBool node, so the section qualifies for the synthetic row', () => {
    const node = load.registry.getNode(SCREENSHOT_NODE);
    expect(node, `${SCREENSHOT_NODE} missing from the demo model`).toBeTruthy();
    const rv = node!.userData?.realvirtual as Record<string, unknown>;
    expect(Object.keys(rv)).toContain('PLCInputBool');
    expect(isPLCSignalComponent('PLCInputBool')).toBe(true);
  });

  it('resolves as a bind target — the slot resolver offers it a Value slot', () => {
    const node = load.registry.getNode(SCREENSHOT_NODE)!;
    const target = findSignalBindTarget(viewer, node);
    expect(target, 'no bind target: the Value slot never reached the resolver').toBeTruthy();
    expect(target!.kind).toBe('node');
    // The target must be the signal node ITSELF, not an ancestor — an ancestor
    // target is exactly how the inspector ends up offering somebody else's slots.
    expect(target!.node.name).toBe('RobotAtConveyorPick');
  });

  it('renders the bind row with a working bracket in the inspector', () => {
    const { container } = render(
      <PLCSignalSlot viewer={viewer} nodePath={SCREENSHOT_NODE} componentType="PLCInputBool" />,
    );
    expect(screen.queryByText(/not offered as a link target/i),
      'the row rendered as unavailable — this is the reported defect').toBeNull();
    expect(screen.queryByText(/not registered in the loaded model/i)).toBeNull();
    expect(bracket(container), 'no link bracket on the row').toBeTruthy();
  });

  /**
   * The cause, named (plan-422 F3). The slot resolver was never the problem:
   * it produces a healthy `mapped-signal` row for this node. What failed was
   * the inspector subtracting two paths that are spelled differently —
   * `getPathForNode()` on the target root against whatever string
   * `selectNode()` happened to store. Through an ALIAS the subtraction yields
   * the whole path instead of `.`, nothing matches the slot's `componentPath`,
   * and the row degrades to "not offered as a link target".
   */
  it('renders identically whether reached by the canonical path or an alias', () => {
    const node = load.registry.getNode(SCREENSHOT_NODE)!;
    const canonical = load.registry.getPathForNode(node)!;
    expect(canonical, 'this model no longer exercises the alias case')
      .not.toBe(SCREENSHOT_NODE);

    const viaAlias = render(
      <PLCSignalSlot viewer={viewer} nodePath={SCREENSHOT_NODE} componentType="PLCInputBool" />,
    );
    expect(bracket(viaAlias.container), 'alias path lost the bracket').toBeTruthy();
    cleanup();

    const viaCanonical = render(
      <PLCSignalSlot viewer={viewer} nodePath={canonical} componentType="PLCInputBool" />,
    );
    expect(bracket(viaCanonical.container), 'canonical path lost the bracket').toBeTruthy();
  });
});

// ── 2. The matrix: every signal type, plus the component slots ───────────

/** A minimal model carrying one raw signal node of `type` under a PLC group. */
async function signalNodeModel(type: string): Promise<{ viewer: RVViewer; path: string }> {
  const root = new Object3D();
  root.name = 'Cell';
  const group = new Object3D();
  group.name = 'PLCInterface';
  root.add(group);
  const sig = new Object3D();
  sig.name = `Sig${type}`;
  sig.userData.realvirtual = { [type]: { Name: `Sig${type}`, Status: { Value: 0 } } };
  group.add(sig);

  const url = URL.createObjectURL(new Blob([await objectToGlb(root)], { type: 'model/gltf-binary' }));
  const load = await loadGLB(url, new Scene(), { loadKinematicsSidecar: false });
  return { viewer: makeViewer(load), path: `Cell/PLCInterface/Sig${type}` };
}

describe.each(SIGNAL_TYPES)('inspector bind row — %s', (type) => {
  it('renders a bindable Value row with a bracket', async () => {
    const { viewer, path } = await signalNodeModel(type);
    expect(isPLCSignalComponent(type)).toBe(true);

    const node = viewer.registry!.getNode(path)!;
    const target = findSignalBindTarget(viewer, node);
    expect(target, `${type}: no bind target`).toBeTruthy();

    const slots = viewer.signalBindingManager!.getElementSlots(path, node, 'own');
    const valueSlot = slots.find((s) => s.slot === PLC_SIGNAL_SLOT);
    expect(valueSlot, `${type}: no Value slot`).toBeTruthy();
    expect(valueSlot!.kind, `${type}: Value slot is unavailable`).toBe('mapped-signal');

    const { container } = render(<PLCSignalSlot viewer={viewer} nodePath={path} componentType={type} />);
    expect(bracket(container), `${type}: no link bracket`).toBeTruthy();
  }, 60_000);
});

// ── 3. Component slots on the same surface (lamp / button) ───────────────

/** `Lamp.SignalLampOn` and `PushButton3D.SignalPressed` are component slots. */
async function componentSlotModel(
  componentType: string,
  extras: Record<string, unknown>,
): Promise<{ viewer: RVViewer; path: string }> {
  const root = new Object3D();
  root.name = 'Cell';
  const plc = new Object3D();
  plc.name = 'PLCInterface';
  root.add(plc);
  const sig = new Object3D();
  sig.name = 'DriveSignal';
  sig.userData.realvirtual = { PLCOutputBool: { Name: 'DriveSignal', Status: { Value: false } } };
  plc.add(sig);
  const host = new Object3D();
  host.name = 'Widget';
  host.userData.realvirtual = { [componentType]: extras };
  root.add(host);

  const url = URL.createObjectURL(new Blob([await objectToGlb(root)], { type: 'model/gltf-binary' }));
  const load = await loadGLB(url, new Scene(), { loadKinematicsSidecar: false });
  return { viewer: makeViewer(load), path: 'Cell/Widget' };
}

const ref = (path: string, componentType: string) =>
  ({ type: 'ComponentReference', path, componentType, componentIndex: 0 });

describe('bindable component slots on the same inspector surface', () => {
  it('a Lamp offers its lightSignal slot', async () => {
    const { viewer, path } = await componentSlotModel('Lamp', {
      _fullTypeName: 'realvirtual.Lamp',
      SignalLampOn: ref('Cell/PLCInterface/DriveSignal', 'realvirtual.PLCOutputBool'),
      OnColor: { r: 1, g: 0.7, b: 0, a: 1 }, Intensity: 2, Period: 1, Flashing: false,
    });
    const node = viewer.registry!.getNode(path)!;
    const target = findSignalBindTarget(viewer, node);
    expect(target, 'lamp is not a bind target').toBeTruthy();
    const slots = viewer.signalBindingManager!.getElementSlots(path, node, 'own');
    expect(slots.some((s) => s.kind !== 'unavailable'), 'lamp has no bindable slot').toBe(true);
  }, 60_000);

  it('a PushButton3D offers its bindable slot', async () => {
    const { viewer, path } = await componentSlotModel('PushButton3D', {
      _fullTypeName: 'realvirtual.PushButton3D',
      lightSignal: ref('Cell/PLCInterface/DriveSignal', 'realvirtual.PLCOutputBool'),
    });
    const node = viewer.registry!.getNode(path)!;
    const target = findSignalBindTarget(viewer, node);
    expect(target, 'button is not a bind target').toBeTruthy();
    const slots = viewer.signalBindingManager!.getElementSlots(path, node, 'own');
    expect(slots.some((s) => s.kind !== 'unavailable'), 'button has no bindable slot').toBe(true);
  }, 60_000);
});

// ── 4. Negative cases: no manager, no crash, no misleading bracket ───────

describe('read-only surfaces state the slot without offering it', () => {
  it('renders an unavailable row and no bracket without a SignalBindingManager', async () => {
    const root = new Object3D();
    root.name = 'Cell';
    const sig = new Object3D();
    sig.name = 'Flag';
    sig.userData.realvirtual = { PLCInputBool: { Name: 'Flag', Status: { Value: false } } };
    root.add(sig);
    const url = URL.createObjectURL(new Blob([await objectToGlb(root)], { type: 'model/gltf-binary' }));
    const load = await loadGLB(url, new Scene(), { loadKinematicsSidecar: false });
    const viewer = makeViewer(load, { manager: false });

    const { container } = render(
      <PLCSignalSlot viewer={viewer} nodePath="Cell/Flag" componentType="PLCInputBool" />,
    );
    expect(screen.getByText(/not available in this session/i)).toBeTruthy();
    expect(bracket(container)).toBeNull();
  }, 60_000);

  it('renders nothing at all for a component that is not a signal', () => {
    expect(isPLCSignalComponent('Drive')).toBe(false);
    const { container } = render(
      <PLCSignalSlot viewer={null} nodePath="Cell/Whatever" componentType="Drive" />,
    );
    expect(container.textContent).toBe('');
  });

  it('survives a null viewer without crashing', () => {
    const { container } = render(
      <PLCSignalSlot viewer={null} nodePath="Cell/Flag" componentType="PLCInputBool" />,
    );
    expect(container.textContent).toContain('not available in this session');
  });
});
