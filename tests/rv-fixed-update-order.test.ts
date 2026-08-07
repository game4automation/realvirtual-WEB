// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase B regression lock — asserts the EXACT per-tick call order the legacy
 * RVViewer.fixedUpdate hard-wired, now produced by CoreSubsystems composed
 * into the SimulationExecutors. If any of these sequences change, simulation
 * behavior changes — treat a failure here as a real regression, not a test
 * to update casually.
 */

import { describe, test, expect } from 'vitest';
import {
  CoreSubsystems,
  type CoreSubsystemsHost,
} from '../src/core/engine/rv-core-subsystems';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import { SimulationKernel } from '../src/core/material-flow/simulation-kernel';
import type { ActiveOnly } from '../src/core/engine/rv-active-only';
import type { Object3D } from 'three';

/** Build a fully instrumented host that records every subsystem call. */
function makeHost(calls: string[], opts?: {
  isConnected?: boolean;
  playbackActive?: ActiveOnly;
  logicActive?: ActiveOnly;
  replayActive?: ActiveOnly;
  driveRunning?: boolean;
  driveJog?: boolean;
  driveTransportSurface?: boolean;
  muCount?: () => number;
  surfaceActive?: boolean;
  hasVanishingMU?: boolean;
}) {
  const muCount = opts?.muCount ?? (() => 0);
  const host: CoreSubsystemsHost = {
    isConnected: opts?.isConnected ?? true,
    playback: {
      isPlaying: true,
      activeOnly: opts?.playbackActive ?? 'Always',
      syncLiveControl: () => calls.push('playback-sync'),
      update: () => calls.push('playback'),
    },
    logicEngine: {
      activeOnly: opts?.logicActive ?? 'Always',
      fixedUpdate: () => calls.push('logic'),
    },
    ikPaths: [{ fixedUpdate: () => calls.push('ik') }],
    replayRecordings: [{
      activeOnly: opts?.replayActive ?? 'Always',
      fixedUpdate: () => calls.push('replay'),
    }],
    drives: [{
      isRunning: opts?.driveRunning ?? true,
      positionOverwrite: false,
      jogForward: opts?.driveJog ?? false,
      jogBackward: false,
      isTransportSurface: opts?.driveTransportSurface ?? false,
      update: () => calls.push('drive'),
    }],
    transportManager: {
      get mus() { return new Array(muCount()); },
      surfaces: [{ isActive: opts?.surfaceActive ?? false }],
      hasVanishingMU: opts?.hasVanishingMU ?? false,
      updateTextureAnimations: () => calls.push('textures'),
    },
    tankFillManager: { update: () => { calls.push('tank'); return false; } },
    pipeFlowManager: { update: () => { calls.push('pipe'); return false; } },
    gizmoManager: { tick: () => { calls.push('gizmo'); return false; } },
    lampManager: { update: () => { calls.push('lamp'); return false; } },
    energyChainManager: { update: () => { calls.push('energyChain'); return false; } },
    collisionManager: { update: () => { calls.push('collision'); return false; } },
    markRenderDirty: () => calls.push('renderDirty'),
    markShadowsDirty: () => calls.push('shadowsDirty'),
  };
  return host;
}

describe('CoreSubsystems stage order (legacy fixedUpdate parity)', () => {
  test('early: playback → logic → IK → replay', () => {
    const calls: string[] = [];
    new CoreSubsystems(makeHost(calls)).early(1 / 60);
    expect(calls).toEqual(['playback-sync', 'playback', 'logic', 'ik', 'replay']);
  });

  test('early respects ActiveOnly/connection guards', () => {
    const calls: string[] = [];
    // Disconnected + everything gated on Connected → only IK (unguarded) runs
    new CoreSubsystems(makeHost(calls, {
      isConnected: false,
      playbackActive: 'Connected',
      logicActive: 'Connected',
      replayActive: 'Connected',
    })).early(1 / 60);
    expect(calls).toEqual(['playback-sync', 'ik']);
  });

  test('drives: running non-jog drive marks render + shadows dirty', () => {
    const calls: string[] = [];
    new CoreSubsystems(makeHost(calls, { driveRunning: true, driveJog: false })).drives(1 / 60);
    expect(calls).toEqual(['drive', 'renderDirty', 'shadowsDirty']);
  });

  test('drives: jogging (conveyor) drive marks render but NOT shadows', () => {
    const calls: string[] = [];
    new CoreSubsystems(makeHost(calls, {
      driveRunning: true,
      driveJog: true,
      driveTransportSurface: true,
    })).drives(1 / 60);
    expect(calls).toEqual(['drive', 'renderDirty']);
  });

  test('drives: jogging positioning drive marks render + shadows dirty', () => {
    const calls: string[] = [];
    new CoreSubsystems(makeHost(calls, { driveRunning: true, driveJog: true })).drives(1 / 60);
    expect(calls).toEqual(['drive', 'renderDirty', 'shadowsDirty']);
  });

  test('drives: MU spawn/despawn diff marks shadows + render exactly on change', () => {
    let count = 0;
    const calls: string[] = [];
    const core = new CoreSubsystems(makeHost(calls, { driveRunning: false, muCount: () => count }));
    core.drives(1 / 60);                 // 0 MUs, no change
    expect(calls).toEqual(['drive']);
    calls.length = 0;
    count = 3;                           // spawn
    core.drives(1 / 60);
    expect(calls).toEqual(['drive', 'shadowsDirty', 'renderDirty']);
    calls.length = 0;
    core.drives(1 / 60);                 // stable count, no flags
    expect(calls).toEqual(['drive']);
  });

  test('visuals: textures → tank → gizmo → pipe → collision', () => {
    const calls: string[] = [];
    new CoreSubsystems(makeHost(calls)).visuals(1 / 60);
    // The collision check (plan-394) runs LAST on purpose: it must see the
    // poses every other subsystem of this tick has already written.
    expect(calls).toEqual(['textures', 'tank', 'gizmo', 'lamp', 'energyChain', 'pipe', 'collision']);
  });

  test('visuals: active belt with MUs marks render + shadows (belt-shadow refresh)', () => {
    const calls: string[] = [];
    new CoreSubsystems(makeHost(calls, { surfaceActive: true, muCount: () => 2 })).visuals(1 / 60);
    expect(calls).toEqual(['textures', 'renderDirty', 'shadowsDirty', 'tank', 'gizmo', 'lamp', 'energyChain', 'pipe', 'collision']);
  });

  test('visuals: null managers are skipped but the gizmo blink loop always runs', () => {
    const calls: string[] = [];
    const host = makeHost(calls);
    const bare: CoreSubsystemsHost = {
      ...host,
      transportManager: null,
      tankFillManager: null,
      pipeFlowManager: null,
      lampManager: null,
      energyChainManager: null,
      collisionManager: null,
    };
    new CoreSubsystems(bare).visuals(1 / 60);
    expect(calls).toEqual(['gizmo']);
  });
});

describe('ContinuousRunner composed tick order (R1 + Phase B)', () => {
  function makeRunner(calls: string[], gate?: () => boolean) {
    const core = new CoreSubsystems(makeHost(calls, { driveRunning: false }));
    const transport = {
      update: () => calls.push('transport'),
      reset: () => calls.push('transport-reset'),
    };
    const behaviors = { tick: () => calls.push('behaviors') };
    return new ContinuousRunner(transport, behaviors, core, gate);
  }

  test('tick: drives → transport → behaviors → visuals (exact legacy order)', () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);
    runner.earlyTick(1 / 60);
    runner.tick(1 / 60);
    expect(calls).toEqual([
      'playback-sync', 'playback', 'logic', 'ik', 'replay', // earlyTick (pre-PRE)
      'drive',                                   // drive loop
      'transport', 'behaviors',                  // R1 pair — never swap
      'textures', 'tank', 'gizmo', 'lamp', 'energyChain', 'pipe', // visual managers
      'collision',                               // collision check runs last
    ]);
  });

  test('transport gate false (physics plugin) skips ONLY transport+behaviors', () => {
    const calls: string[] = [];
    const runner = makeRunner(calls, () => false);
    runner.tick(1 / 60);
    expect(calls).toEqual(['drive', 'textures', 'tank', 'gizmo', 'lamp', 'energyChain', 'pipe', 'collision']);
  });

  test('legacy 2-arg construction (no core) keeps the historical pair order', () => {
    const calls: string[] = [];
    const runner = new ContinuousRunner(
      { update: () => calls.push('transport'), reset: () => {} },
      { tick: () => calls.push('behaviors') },
    );
    runner.earlyTick(1 / 60); // no core → no-op
    runner.tick(1 / 60);
    expect(calls).toEqual(['transport', 'behaviors']);
  });
});

describe('SimulationKernel earlyTick delegation', () => {
  test('kernel.earlyTick reaches the active executor', () => {
    const calls: string[] = [];
    const core = new CoreSubsystems(makeHost(calls, { driveRunning: false }));
    const runner = new ContinuousRunner(
      { update: () => calls.push('transport'), reset: () => {} },
      { tick: () => calls.push('behaviors') },
      core,
    );
    const kernel = new SimulationKernel({
      continuousRunner: runner,
      topology: { root: {} as unknown as Object3D },
    });
    kernel.earlyTick(1 / 60);
    kernel.tick(1 / 60);
    kernel.lateTick(1 / 60);
    expect(calls).toEqual([
      'playback-sync', 'playback', 'logic', 'ik', 'replay',
      'drive',
      'transport', 'behaviors',
      'textures', 'tank', 'gizmo', 'lamp', 'energyChain', 'pipe', 'collision',
    ]);
  });
});
