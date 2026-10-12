// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * emergency-button-nc.test.ts — plan-538 F4: EmergencyButton3D `NormallyClosed`.
 *
 * NC: the state signal is true while the button is released (OK) and false
 * while pressed; the released value is written at start. NO (default) keeps
 * today's behaviour (signal = pressed). Built through the real loader pipeline
 * (`processExtras`) with the demo hierarchy of the scene-button fixture.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalReapplyRegistry } from '../src/core/engine/rv-signal-reapply-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SceneButtonManager } from '../src/core/engine/rv-scene-button-manager';
import type { RVSceneButtonBase } from '../src/core/engine/rv-scene-button-base';
import type { RVEmergencyButton3D } from '../src/core/engine/rv-emergency-button3d';
import { baseExtras, mesh, moveableExtras, node, ref, signal } from './scene-button-fixture';

const SIGNAL = 'Cell/PLC/EStop';
const WRAPPER = 'Cell/EmergencyButton';
const CAP = 'Cell/EmergencyButton/PushButton/Button';

function build(opts: { normallyClosed?: boolean; activeOnStart?: boolean; signalStart?: boolean } = {}) {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  scene.add(root);
  const plc = node(root, 'PLC');
  signal(plc, 'EStop', 'PLCInputBool', opts.signalStart ?? false);
  const wrapper = node(root, 'EmergencyButton', {
    EmergencyButton3D: {
      _fullTypeName: 'realvirtual.EmergencyButton3D',
      stateSignal: ref(SIGNAL, 'realvirtual.PLCInputBool'),
      activeOnStart: opts.activeOnStart ?? false,
      ...(opts.normallyClosed !== undefined ? { NormallyClosed: opts.normallyClosed } : {}),
      Name: '',
      Active: 'Always',
    },
  });
  const inner = node(wrapper, 'PushButton');
  mesh(inner, 'Base');
  mesh(inner, 'Button', {
    ...moveableExtras({ capPath: CAP, baseMaterial: 'PlasticRed', activeMaterial: 'PlasticRed', activeOffset: -0.005 }),
    ...baseExtras(CAP, { isToggle: true, autoLight: false }),
  });

  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const sceneButtonManager = new SceneButtonManager();
  const reapply = new SignalReapplyRegistry();
  processExtras(root, buildInitContext({
    registry, signalStore, transportManager, scene, sceneButtonManager, reapply,
  }));
  const base = registry.getByPath<RVSceneButtonBase>('SceneButtonBase', CAP)!;
  const wrap = registry.getByPath<RVEmergencyButton3D>('EmergencyButton3D', WRAPPER)!;
  return { signalStore, base, wrap, reapply, value: () => signalStore.getBoolByPath(SIGNAL) };
}

describe('plan-538 F4 — EmergencyButton3D NormallyClosed', () => {
  it('NC released → true at init (GLB start value false), press → false, release → true', () => {
    const h = build({ normallyClosed: true });
    expect(h.wrap.NormallyClosed).toBe(true);
    expect(h.base.active).toBe(false); // released visuals
    expect(h.value()).toBe(true);

    h.base.onClick(); // latching mushroom: press
    expect(h.base.active).toBe(true);
    expect(h.value()).toBe(false);

    h.base.onClick(); // release
    expect(h.base.active).toBe(false);
    expect(h.value()).toBe(true);
  });

  it('NO default unchanged: false at init, press → true, release → false', () => {
    const h = build();
    expect(h.wrap.NormallyClosed).toBe(false);
    expect(h.value()).toBe(false);
    h.base.onClick();
    expect(h.value()).toBe(true);
    h.base.onClick();
    expect(h.value()).toBe(false);
  });

  it('NC signal read-back: an external false shows pressed, true released; a re-apply does not flip the state', () => {
    const h = build({ normallyClosed: true });
    h.signalStore.setByPath(SIGNAL, false); // e.g. remote / forced: pressed
    expect(h.base.active).toBe(true);
    h.reapply.reapplyAll();
    expect(h.base.active).toBe(true);
    expect(h.value()).toBe(false);

    h.signalStore.setByPath(SIGNAL, true);
    expect(h.base.active).toBe(false);
    h.reapply.reapplyAll();
    expect(h.base.active).toBe(false);
    expect(h.value()).toBe(true);
  });

  it('NC with activeOnStart: the self-click presses the head → signal false', () => {
    const h = build({ normallyClosed: true, activeOnStart: true });
    expect(h.base.active).toBe(true);
    expect(h.value()).toBe(false);
  });
});
