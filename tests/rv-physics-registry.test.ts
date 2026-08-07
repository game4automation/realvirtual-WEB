// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-registry.test.ts — plan-276 test 9.1 (Phase 1 scope; gate
 * matrix updated for the Phase-3 scope change: `rv.physics` is an OPT-IN
 * ACTIVATION toggle, default OFF).
 *
 * Registry fallback + activation gate: without a registered provider the
 * feature is a strict no-op (F1); the load-time gate (F10) ANDs the
 * settings.json kill-switch (default true = allowed) with the localStorage
 * `rv.physics` activation toggle (only 'on' | 'true' | '1' enable).
 *
 * Pure-TS tests against the public registry with an injectable
 * MockPhysicsProvider (pattern: `ik-tier.test.ts`) — no WASM is loaded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  physicsRegistry,
  physicsSettings,
  computePhysicsEnabled,
  computeFullPhysics,
  isPhysicsFlagEnabled,
  isFullPhysicsFlagEnabled,
  PHYSICS_FLAG_KEY,
  PHYSICS_FULL_FLAG_KEY,
  type PhysicsAABB,
  type PhysicsPose,
  type PhysicsProvider,
  type PhysicsQuat,
  type PhysicsRayHit,
  type PhysicsVec3,
  type PhysicsZoneConfig,
} from '../src/core/engine/rv-physics-registry';

const V0: PhysicsVec3 = { x: 0, y: 0, z: 0 };
const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const POSE: PhysicsPose = { pos: { x: 0, y: 1, z: 0 }, quat: Q_IDENT };
const AABB: PhysicsAABB = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
const ZONE_CFG: PhysicsZoneConfig = { friction: 0.8, restitution: 0, removeBelowY: -10 };

/** Injectable mock provider — records calls, no physics. */
class MockPhysicsProvider implements PhysicsProvider {
  ready = false;
  failed = false;
  initCalls = 0;
  disposeCalls = 0;
  stepCalls = 0;
  addedMUs: string[] = [];
  removedMUs: string[] = [];
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;

  async init(): Promise<void> {
    this.initCalls++;
    this.ready = true;
  }
  dispose(): void {
    this.disposeCalls++;
    this.ready = false;
  }
  addZone(_id: string, _aabb: PhysicsAABB, _cfg: PhysicsZoneConfig): void {}
  addStaticBox(_id: string, _c: PhysicsVec3, _he: PhysicsVec3, _q: PhysicsQuat): void {}
  addConveyor(_id: string, _c: PhysicsVec3, _he: PhysicsVec3, _q: PhysicsQuat, _f: number): void {}
  setConveyorVelocity(_id: string, _vel: PhysicsVec3): void {}
  addDynamicMU(muId: string, _pose: PhysicsPose, _he: PhysicsVec3, _vel: PhysicsVec3): void {
    this.addedMUs.push(muId);
  }
  removeBody(muId: string): void {
    this.removedMUs.push(muId);
  }
  addSensorBox(_id: string, _c: PhysicsVec3, _he: PhysicsVec3, _q: PhysicsQuat): void {}
  castRay(_o: PhysicsVec3, _d: PhysicsVec3, _m: number): PhysicsRayHit | null {
    return null;
  }
  step(_dt: number): void {
    this.stepCalls++;
  }
  syncPoses(_out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void {}
  getSettledBodies(_maxLinVel: number, _uprightToleranceDeg: number): string[] {
    return [];
  }
}

describe('physicsRegistry — no-op fallback (F1)', () => {
  beforeEach(() => physicsRegistry.register(null));
  afterEach(() => physicsRegistry.register(null));

  it('returns null provider by default (feature off)', () => {
    expect(physicsRegistry.provider).toBeNull();
  });

  it('optional-chained call sites are a strict no-op without a provider', () => {
    // Mirrors the call-site idiom of the plugin/transport code — must never throw.
    expect(() => {
      physicsRegistry.provider?.step(1 / 60);
      physicsRegistry.provider?.syncPoses(() => {});
      physicsRegistry.provider?.removeBody('mu1');
      physicsRegistry.provider?.addDynamicMU('mu1', POSE, V0, V0);
    }).not.toThrow();
    expect(physicsRegistry.provider?.getSettledBodies(0.01, 25) ?? []).toEqual([]);
    expect(physicsRegistry.provider?.castRay(V0, { x: 0, y: -1, z: 0 }, 10) ?? null).toBeNull();
  });

  it('register/unregister roundtrip (null restores the no-op state)', () => {
    const mock = new MockPhysicsProvider();
    physicsRegistry.register(mock);
    expect(physicsRegistry.provider).toBe(mock);
    physicsRegistry.register(null);
    expect(physicsRegistry.provider).toBeNull();
  });

  it('registered provider receives calls through the registry', () => {
    const mock = new MockPhysicsProvider();
    physicsRegistry.register(mock);
    physicsRegistry.provider?.addZone('z1', AABB, ZONE_CFG);
    physicsRegistry.provider?.addDynamicMU('mu1', POSE, { x: 0.1, y: 0.1, z: 0.1 }, V0);
    physicsRegistry.provider?.step(1 / 60);
    physicsRegistry.provider?.removeBody('mu1');
    expect(mock.addedMUs).toEqual(['mu1']);
    expect(mock.stepCalls).toBe(1);
    expect(mock.removedMUs).toEqual(['mu1']);
  });
});

describe('physics activation gate (F10 — load-time-only, opt-in default OFF)', () => {
  beforeEach(() => {
    localStorage.removeItem(PHYSICS_FLAG_KEY);
    physicsSettings.enabled = false;
  });
  afterEach(() => {
    localStorage.removeItem(PHYSICS_FLAG_KEY);
    physicsSettings.enabled = false;
  });

  it('defaults: no settings.json flag, no localStorage key → DISABLED (opt-in)', () => {
    expect(isPhysicsFlagEnabled()).toBe(false);
    expect(computePhysicsEnabled(undefined)).toBe(false);
    expect(computePhysicsEnabled(true)).toBe(false);
    // The module-level default mirrors the opt-in semantics.
    expect(physicsSettings.enabled).toBe(false);
  });

  it("activation values 'on' | 'true' | '1' enable when the config allows", () => {
    for (const v of ['on', 'true', '1']) {
      localStorage.setItem(PHYSICS_FLAG_KEY, v);
      expect(isPhysicsFlagEnabled()).toBe(true);
      expect(computePhysicsEnabled(true)).toBe(true);
      expect(computePhysicsEnabled(undefined)).toBe(true);
    }
  });

  it('settings.json physicsEnabled=false disables regardless of localStorage (kill-switch wins)', () => {
    expect(computePhysicsEnabled(false)).toBe(false);
    localStorage.setItem(PHYSICS_FLAG_KEY, 'on');
    expect(computePhysicsEnabled(false)).toBe(false);
  });

  it('every non-activation value keeps the switch OFF (default OFF)', () => {
    for (const v of ['off', 'false', '0', 'yes', 'enabled', '']) {
      localStorage.setItem(PHYSICS_FLAG_KEY, v);
      expect(isPhysicsFlagEnabled()).toBe(false);
      expect(computePhysicsEnabled(true)).toBe(false);
    }
  });

  it('physicsSettings.enabled mirrors the boot-time evaluation (main.ts idiom)', () => {
    // Simulate the main.ts boot block: gate written once from config + flag.
    localStorage.setItem(PHYSICS_FLAG_KEY, 'on');
    physicsSettings.enabled = computePhysicsEnabled(true);
    expect(physicsSettings.enabled).toBe(true);

    // Missing key = user never opted in → OFF even with a permissive config.
    localStorage.removeItem(PHYSICS_FLAG_KEY);
    physicsSettings.enabled = computePhysicsEnabled(undefined);
    expect(physicsSettings.enabled).toBe(false);
  });

  it('gate=false means the plugin must not init the provider (no lazy import)', () => {
    // Phase-1 contract check: the Phase-3 plugin gates on physicsSettings
    // BEFORE touching the provider. Modelled here against the mock.
    const mock = new MockPhysicsProvider();
    physicsRegistry.register(mock);
    physicsSettings.enabled = computePhysicsEnabled(false);

    // Plugin-side idiom (zones present, but gate closed → no init call):
    const zonesInModel = 1;
    if (physicsSettings.enabled && zonesInModel > 0) void physicsRegistry.provider?.init();
    expect(mock.initCalls).toBe(0);

    // Gate open (explicit opt-in) + no zones → still no init in the explicit-
    // zones idiom (F1). Since the scope change, NO zones + open gate instead
    // synthesize a WholeScene zone (F16) — covered in rv-physics-lifecycle.
    localStorage.setItem(PHYSICS_FLAG_KEY, 'on');
    physicsSettings.enabled = computePhysicsEnabled(undefined);
    expect(physicsSettings.enabled).toBe(true);
    const noZones = 0;
    if (physicsSettings.enabled && noZones > 0) void physicsRegistry.provider?.init();
    expect(mock.initCalls).toBe(0);

    physicsRegistry.register(null);
  });
});

describe('full-physics gate (F17 — Beta, strict AND with the base gate)', () => {
  beforeEach(() => {
    localStorage.removeItem(PHYSICS_FLAG_KEY);
    localStorage.removeItem(PHYSICS_FULL_FLAG_KEY);
    physicsSettings.enabled = false;
    physicsSettings.full = false;
  });
  afterEach(() => {
    localStorage.removeItem(PHYSICS_FLAG_KEY);
    localStorage.removeItem(PHYSICS_FULL_FLAG_KEY);
    physicsSettings.enabled = false;
    physicsSettings.full = false;
  });

  it('defaults: no keys → full OFF (Beta opt-in)', () => {
    expect(isFullPhysicsFlagEnabled()).toBe(false);
    expect(computeFullPhysics(undefined)).toBe(false);
    expect(computeFullPhysics(true)).toBe(false);
    // The module-level default mirrors the opt-in semantics.
    expect(physicsSettings.full).toBe(false);
  });

  it("activation values 'on' | 'true' | '1' enable the full FLAG", () => {
    for (const v of ['on', 'true', '1']) {
      localStorage.setItem(PHYSICS_FULL_FLAG_KEY, v);
      expect(isFullPhysicsFlagEnabled()).toBe(true);
    }
  });

  it('every non-activation value keeps the full flag OFF', () => {
    for (const v of ['off', 'false', '0', 'yes', 'beta', '']) {
      localStorage.setItem(PHYSICS_FULL_FLAG_KEY, v);
      expect(isFullPhysicsFlagEnabled()).toBe(false);
    }
  });

  it('full flag WITHOUT the base rv.physics opt-in is ineffective (AND semantics)', () => {
    localStorage.setItem(PHYSICS_FULL_FLAG_KEY, 'on');
    expect(isFullPhysicsFlagEnabled()).toBe(true);
    // Base toggle missing → full physics stays OFF regardless of config.
    expect(computeFullPhysics(true)).toBe(false);
    expect(computeFullPhysics(undefined)).toBe(false);
  });

  it('full + base toggle + permissive config → ON', () => {
    localStorage.setItem(PHYSICS_FLAG_KEY, 'on');
    localStorage.setItem(PHYSICS_FULL_FLAG_KEY, 'on');
    expect(computeFullPhysics(true)).toBe(true);
    expect(computeFullPhysics(undefined)).toBe(true);
  });

  it('base toggle WITHOUT the full flag → base on, full off', () => {
    localStorage.setItem(PHYSICS_FLAG_KEY, 'on');
    expect(computePhysicsEnabled(undefined)).toBe(true);
    expect(computeFullPhysics(undefined)).toBe(false);
  });

  it('settings.json physicsEnabled=false kill-switch wins over BOTH toggles', () => {
    localStorage.setItem(PHYSICS_FLAG_KEY, 'on');
    localStorage.setItem(PHYSICS_FULL_FLAG_KEY, 'on');
    expect(computeFullPhysics(false)).toBe(false);
  });

  it('physicsSettings.full mirrors the boot-time evaluation (main.ts idiom)', () => {
    localStorage.setItem(PHYSICS_FLAG_KEY, 'on');
    localStorage.setItem(PHYSICS_FULL_FLAG_KEY, 'on');
    physicsSettings.enabled = computePhysicsEnabled(true);
    physicsSettings.full = computeFullPhysics(true);
    expect(physicsSettings.enabled).toBe(true);
    expect(physicsSettings.full).toBe(true);

    // User turns the BASE toggle off → the derived full gate collapses too.
    localStorage.removeItem(PHYSICS_FLAG_KEY);
    physicsSettings.enabled = computePhysicsEnabled(true);
    physicsSettings.full = computeFullPhysics(true);
    expect(physicsSettings.enabled).toBe(false);
    expect(physicsSettings.full).toBe(false);
  });
});
