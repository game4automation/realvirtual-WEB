// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-schema.test.ts — plan-417 §9.1.
 *
 * The Unity SceneButtons classes use camelCase field names, unlike the rest of
 * realvirtual. A schema key that silently differs from the GLB key produces no
 * error at all — the value is simply never applied — so the mapping is pinned
 * here against extras taken verbatim from `DemoRealvirtualWeb.glb`.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import { RVSceneButtonBase } from '../src/core/engine/rv-scene-button-base';
import { RVSceneButtonMoveable } from '../src/core/engine/rv-scene-button-moveable';
import { RVPushButton3D } from '../src/core/engine/rv-push-button3d';
import { RVEmergencyButton3D } from '../src/core/engine/rv-emergency-button3d';
import { RVHandleSwitch3D } from '../src/core/engine/rv-handle-switch3d';
import { buildButtonScene, PATHS } from './scene-button-fixture';

describe('SceneButton schema', () => {
  it('declares the exact camelCase field set of the Unity classes', () => {
    expect(Object.keys(loadSchemaFromSpec('SceneButtonBase')).sort())
      .toEqual(['autoLight', 'isToggle', 'moveable', 'simpleClickTime']);
    expect(Object.keys(loadSchemaFromSpec('SceneButtonMoveable')).sort())
      .toEqual(['activeOffset', 'angularMovement', 'axis', 'hoverOffset', 'mirrorHoverOffset', 'moveSpeed']);
    expect(Object.keys(loadSchemaFromSpec('PushButton3D')).sort())
      .toEqual(['activeOnStart', 'label', 'lightSignal', 'stateSignal', 'timer', 'toggle']);
    expect(Object.keys(loadSchemaFromSpec('EmergencyButton3D')).sort())
      .toEqual(['activeOnStart', 'stateSignal']);
    expect(Object.keys(loadSchemaFromSpec('HandleSwitch3D')).sort())
      .toEqual(['activeOnStart', 'stateSignal']);
  });

  it('types the signal slots as PLC signal component refs', () => {
    for (const type of ['PushButton3D', 'EmergencyButton3D', 'HandleSwitch3D']) {
      expect(loadSchemaFromSpec(type).stateSignal)
        .toEqual({ type: 'componentRef', signal: 'PLCInputBool' });
    }
    expect(loadSchemaFromSpec('PushButton3D').lightSignal)
      .toEqual({ type: 'componentRef', signal: 'PLCOutputBool' });
    // `moveable` is a plain component ref, NOT a bindable signal slot.
    expect(loadSchemaFromSpec('SceneButtonBase').moveable).toEqual({ type: 'componentRef' });
  });

  it('keeps the Unity material descriptors and renderer out of the schema (rawFields)', () => {
    const schema = loadSchemaFromSpec('SceneButtonMoveable');
    expect(schema.baseMaterial).toBeUndefined();
    expect(schema.activeMaterial).toBeUndefined();
    expect(schema.renderer).toBeUndefined();
    expect(schema.currentOffset).toBeUndefined();
  });

  it('maps PushButton3D extras incl. stateSignal/lightSignal refs', () => {
    const h = buildButtonScene();
    const push = h.get<RVPushButton3D>('PushButton3D', PATHS.pushWrapper);

    expect(push).toBeInstanceOf(RVPushButton3D);
    expect(push.label).toBe('Automatic');
    expect(push.timer).toBe(0.3);
    expect(push.toggle).toBe(false);
    expect(push.activeOnStart).toBe(false);
    // Component refs resolve to the registered signal PATHS.
    expect(push.stateSignal).toBe(PATHS.automaticButtonSignal);
    expect(push.lightSignal).toBe(PATHS.automaticLightSignal);
  });

  it('maps SceneButtonBase incl. the moveable instance reference', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.pushBase);

    expect(base).toBeInstanceOf(RVSceneButtonBase);
    expect(base.moveable).toBeInstanceOf(RVSceneButtonMoveable);
    expect(base.moveable).toBe(h.cap(PATHS.pushCap));
    // The wrapper overrides the authored defaults (Unity PushButton3D.Start).
    expect(base.simpleClickTime).toBe(0.3);
    expect(base.isToggle).toBe(false);
    // lightSignal wired → the light no longer follows the button state.
    expect(base.autoLight).toBe(false);
  });

  it('maps SceneButtonMoveable axis/offsets/angularMovement', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap);

    expect(cap.axis).toBeInstanceOf(Vector3);
    expect(cap.axis.toArray()).toEqual([-0, 0, 1]);   // unityCoords: X negated
    expect(cap.moveSpeed).toBe(30);
    expect(cap.hoverOffset).toBeCloseTo(0.002);
    expect(cap.activeOffset).toBeCloseTo(-0.007);
    expect(cap.angularMovement).toBe(false);

    const handleCap = h.cap(PATHS.handleCap);
    expect(handleCap.angularMovement).toBe(true);
    expect(handleCap.mirrorHoverOffset).toBe(true);
    expect(handleCap.activeOffset).toBe(90);
  });

  it('maps the signal-only wrappers', () => {
    const h = buildButtonScene();
    const emergency = h.get<RVEmergencyButton3D>('EmergencyButton3D', PATHS.emergencyWrapper);
    const handle = h.get<RVHandleSwitch3D>('HandleSwitch3D', PATHS.handleWrapper);

    expect(emergency.stateSignal).toBe(PATHS.emergencySignal);
    expect(emergency.activeOnStart).toBe(false);
    expect(handle.stateSignal).toBe(PATHS.onSwitchSignal);
    expect(handle.activeOnStart).toBe(true);
  });
});
