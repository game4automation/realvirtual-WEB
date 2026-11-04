// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { installRecordingSeam, registerRecordingTarget } from '../src/core/engine/rv-recording-targets';
import { commandRegistry, type CommandContext } from '../src/core/hmi/rv-command-registry';

let originalUrl: string;
let originalHistoryState: unknown;
const disposers: Array<() => void> = [];

function setRecording(enabled: boolean) {
  const url = new URL(window.location.href);
  if (enabled) url.searchParams.set('recording', '1');
  else url.searchParams.delete('recording');
  window.history.replaceState(window.history.state, '', url);
}

beforeEach(() => {
  originalUrl = window.location.href;
  originalHistoryState = window.history.state;
  delete window.__rvRecording;
  setRecording(true);
});

afterEach(() => {
  window.__rvRecording?.stopCommandWatch();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  delete window.__rvRecording;
  window.history.replaceState(originalHistoryState, '', originalUrl);
});

function sceneFixture() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const nodes = new Map<string, Object3D>();
  const viewer = {
    camera,
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }) } },
    registry: {
      getNode: (path: string) => nodes.get(path) ?? null,
      forEachNode: (cb: (path: string, node: Object3D) => void) => nodes.forEach((node, path) => cb(path, node)),
    },
  } as unknown as RVViewer;
  const add = (path: string, node = new Object3D()) => {
    scene.add(node);
    nodes.set(path, node);
    return node;
  };
  return { viewer, add };
}

async function installed(viewer = sceneFixture().viewer) {
  await installRecordingSeam(viewer);
  expect(window.__rvRecording).toBeDefined();
  return window.__rvRecording!;
}

async function pickFixture() {
  const { viewer, add } = sceneFixture();
  // Reverse insertion order makes the tie test distinguish sorting from first match.
  const second = add('Yard/AGV_2');
  const first = add('Yard/AGV_1');
  second.userData.realvirtual = { AgvBehavior: {} };
  first.userData.realvirtual = { Agv: {} };
  const conveyor = add('Yard/Conv');
  const seam = await installed(viewer);
  return { seam, first, second, conveyor };
}

describe('recording seam', () => {
  it('Test_InstallRecordingSeam_WithoutOptIn_LeavesGlobalUndefined', async () => {
    setRecording(false);
    await installRecordingSeam(sceneFixture().viewer);
    expect(window.__rvRecording).toBeUndefined();
  });

  it('Test_InstallRecordingSeam_WithOptIn_InstallsOnlyOnce', async () => {
    const viewer = sceneFixture().viewer;
    const seam = await installed(viewer);
    await installRecordingSeam(viewer);
    expect(window.__rvRecording).toBe(seam);
  });

  it('Test_RegisterRecordingTarget_Unregister_RemovesResolver', async () => {
    const resolve = vi.fn((key: string) => key === 'Station' ? { x: 12, y: 34 } : null);
    const unregister = registerRecordingTarget('test-recording-target', resolve);
    disposers.push(unregister);
    const seam = await installed();
    expect(seam.target('test-recording-target', 'Station')).toEqual({ x: 12, y: 34 });
    expect(resolve).toHaveBeenCalledWith('Station');
    unregister();
    expect(seam.target('test-recording-target', 'Station')).toBeNull();
  });

  it('Test_RegisterRecordingTarget_StaleUnregister_PreservesReplacement', async () => {
    const unregister = registerRecordingTarget('test-recording-target', () => ({ x: 1, y: 2 }));
    disposers.push(unregister);
    disposers.push(registerRecordingTarget('test-recording-target', () => ({ x: 3, y: 4 })));
    const seam = await installed();
    unregister();
    expect(seam.target('test-recording-target', 'Station')).toEqual({ x: 3, y: 4 });
  });

  it('Test_NodeScreen_BoxAtOrigin_ProjectsCenterAndTop', async () => {
    const { viewer, add } = sceneFixture();
    const geometry = new BoxGeometry(2, 2, 2);
    const material = new MeshBasicMaterial();
    disposers.push(() => { geometry.dispose(); material.dispose(); });
    add('Yard/Box', new Mesh(geometry, material));
    const behind = add('Yard/Behind', new Mesh(geometry, material));
    behind.position.z = 20;
    const seam = await installed(viewer);
    const center = seam.nodeScreen('Yard/Box', 'center');
    const top = seam.nodeScreen('Yard/Box', 'top');
    expect(center).not.toBeNull();
    expect(top).not.toBeNull();
    expect(Math.abs(center!.x - 500)).toBeLessThanOrEqual(1);
    expect(Math.abs(center!.y - 350)).toBeLessThanOrEqual(1);
    expect(top!.y).toBeLessThan(center!.y);
    expect(seam.nodeScreen('Yard/Unknown')).toBeNull();
    expect(seam.nodeScreen('Yard/Behind')).toBeNull();
  });

  it('Test_Pick_DifferentDistances_ReturnsFastestMatchingVehicle', async () => {
    const { seam, first, second, conveyor } = await pickFixture();
    const token = seam.pickBegin('moving-vehicle', 'Yard/AGV_*');
    first.position.x = 2;
    second.position.x = 5;
    conveyor.position.x = 100;
    expect(seam.pickEnd(token, 1)).toEqual({ path: 'Yard/AGV_2' });
  });

  it('Test_Pick_EqualDistances_ReturnsLexicographicallySmallestPath', async () => {
    const { seam, first, second } = await pickFixture();
    const token = seam.pickBegin('moving-vehicle', 'Yard/AGV_*');
    first.position.x = -3;
    second.position.y = 3;
    expect(seam.pickEnd(token, 1)).toEqual({ path: 'Yard/AGV_1' });
  });

  it('Test_Pick_FasterNonVehicleAndChildInGlob_ReturnsVehicleRoot', async () => {
    const { viewer, add } = sceneFixture();
    const vehicle = add('Yard/Vehicle');
    vehicle.userData.realvirtual = { Agv: {} };
    const child = add('Yard/Vehicle/Fork');
    vehicle.add(child);
    const mu = add('Yard/MU');
    mu.userData.realvirtual = { MU: {} };
    const seam = await installed(viewer);
    const token = seam.pickBegin('moving-vehicle', 'Yard/**');
    vehicle.position.x = 2;
    child.position.x = 20;
    mu.position.x = 100;
    expect(seam.pickEnd(token, 1)).toEqual({ path: 'Yard/Vehicle' });

    const stationaryRoot = seam.pickBegin('moving-vehicle', 'Yard/**');
    child.position.x = 40;
    mu.position.x = 200;
    expect(seam.pickEnd(stationaryRoot, 1)).toEqual({ error: 'pick-no-match' });
  });

  it('Test_Pick_NoMovement_ReturnsNoMatch', async () => {
    const { seam } = await pickFixture();
    const token = seam.pickBegin('moving-vehicle', 'Yard/AGV_*');
    expect(seam.pickEnd(token, 1)).toEqual({ error: 'pick-no-match' });
  });

  it('Test_Pick_OnlyNonMatchingNodeMoves_ReturnsNoMatch', async () => {
    const { seam, conveyor } = await pickFixture();
    const token = seam.pickBegin('moving-vehicle', 'Yard/AGV_*');
    conveyor.position.x = 100;
    expect(seam.pickEnd(token, 1)).toEqual({ error: 'pick-no-match' });
  });

  it('Test_Execute_RegisteredCommand_RunsWithUiOriginAndDrainsWatch', async () => {
    const viewer = sceneFixture().viewer;
    commandRegistry.attachViewer(viewer);
    disposers.push(() => commandRegistry.attachViewer(undefined));
    const run = vi.fn((ctx: CommandContext, args: { path: string }) => ({ origin: ctx.origin, path: args.path }));
    disposers.push(commandRegistry.register({
      id: 'test.recording.execute', label: 'Recording test', readOnly: true,
      scope: 'none', available: true, unavailableReason: 'Unavailable', argsSchema: { path: 'string' },
      impl: async () => ({ enabled: () => true, run }),
    }));
    const seam = await installed(viewer);
    const args = { path: 'Yard/AGV_1' };
    seam.armCommandWatch();
    expect(seam.takeCommandWatch()).toEqual([]);
    expect(await seam.execute('test.recording.execute', args)).toEqual({
      ok: true, value: { origin: 'ui', path: args.path },
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origin: 'ui', viewer }), args);
    expect(seam.takeCommandWatch()).toEqual([{ id: 'test.recording.execute', args, ok: true }]);
    expect(seam.takeCommandWatch()).toEqual([]);
  });

  it('Test_Execute_WithoutAttachedViewer_ViewerDependentCommandUsesSeamViewer', async () => {
    const viewer = sceneFixture().viewer;
    commandRegistry.attachViewer(undefined); // recording page: MCP never attached a viewer
    const run = vi.fn((ctx: CommandContext) => ({ hasViewer: ctx.viewer === viewer }));
    disposers.push(commandRegistry.register({
      id: 'test.recording.needsviewer', label: 'Needs viewer', readOnly: true,
      scope: 'none', available: true, unavailableReason: 'Unavailable', argsSchema: {},
      impl: async () => ({ enabled: () => true, run }),
    }));
    const seam = await installed(viewer);
    expect(await seam.execute('test.recording.needsviewer')).toEqual({ ok: true, value: { hasViewer: true } });
  });

  it('Test_CommandWatch_Stop_ReleasesSubscriptionAndClearsBuffer', async () => {
    const viewer = sceneFixture().viewer;
    commandRegistry.attachViewer(viewer);
    disposers.push(() => commandRegistry.attachViewer(undefined));
    disposers.push(commandRegistry.register({
      id: 'test.recording.lifecycle', label: 'Recording lifecycle test', readOnly: true,
      scope: 'none', available: true, unavailableReason: 'Unavailable', argsSchema: {},
      impl: async () => ({ enabled: () => true, run: () => null }),
    }));
    const onExecuted = commandRegistry.onExecuted.bind(commandRegistry);
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(commandRegistry, 'onExecuted').mockImplementation((listener) => {
      const stop = vi.fn(onExecuted(listener));
      stops.push(stop);
      return stop;
    });
    const seam = await installed(viewer);
    seam.armCommandWatch();
    expect(await seam.execute('test.recording.lifecycle')).toEqual({ ok: true, value: null });
    expect(seam.takeCommandWatch()).toHaveLength(1);
    await seam.execute('test.recording.lifecycle');
    seam.stopCommandWatch();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(seam.takeCommandWatch()).toEqual([]);
    await seam.execute('test.recording.lifecycle');
    expect(seam.takeCommandWatch()).toEqual([]);
    seam.stopCommandWatch();
    expect(stops[0]).toHaveBeenCalledTimes(1);

    seam.armCommandWatch();
    await seam.execute('test.recording.lifecycle');
    expect(seam.takeCommandWatch()).toHaveLength(1);
    seam.stopCommandWatch();
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });

  it('Test_DesClock_ReadsRenderClockOrNullWithoutKernel', async () => {
    const base = sceneFixture().viewer as unknown as Record<string, unknown>;
    const ctl = { renderClock: 7200.5, simTime: 7200.1, subMode: 'hybrid', multiplier: 5 };
    const withKernel = { ...base, simulationKernel: { desControl: () => ctl } } as unknown as RVViewer;
    const seam = await installed(withKernel);
    expect(seam.desClock()).toEqual({ renderClock: 7200.5, simTime: 7200.1, subMode: 'hybrid', multiplier: 5 });
    delete window.__rvRecording;
    const none = await installed({ ...base, simulationKernel: { desControl: () => null } } as unknown as RVViewer);
    expect(none.desClock()).toBeNull();
  });
});
