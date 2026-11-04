// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// The robot of the standard demo moves within 30 s of SIM time (regression guard, 2026-10-31).
//
// The cell control is plain LogicSteps in the GLB (DemoCell/MainCycle/"Robot and Machine Cycle"):
// the operator gates (OnSwitch, EmergencyButton=false, AutomaticLight, RobotButton), then the
// first part at EntrySensor, then `LoadCell` — which starts the robot's ReplayRecording "Loading".
// The first part reaches the sensor at ~12-13 s sim time. Headless on CPU rendering the sim runs
// at ~0.3x real time, so a wall-clock look shorter than ~40 s sees "A2 stays 0" although nothing
// is broken — this test answers the question in sim time instead.
//
// Runs in both configurations: the default one and the community build
// (`VITE_PUBLIC_BUILD=1 npx vitest run tests/demo-standard-robot-moves.test.ts`), where no private
// plugin is loaded — the cell control must not depend on one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import { registerAllBehaviors } from '../src/core/behaviors';

const SCENE_URL = '/demo-realvirtual/DemoRealvirtualWeb.glb';
const DT = 1 / 60;
const SIM_SECONDS = 30;
/** Pause reason that keeps the viewer's real-time loop from advancing the sim behind the test. */
const HOLD = 'demo-standard-robot-moves';

let handle: TestViewerHandle;
let viewer: RVViewer;

const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };
const axis = (name: string): number => {
  const d = viewer.drives.find(x => (x.name ?? x.node?.name) === name);
  if (!d) throw new Error(`drive ${name} not found (${viewer.drives.length} drives)`);
  return d.currentPosition;
};

beforeAll(async () => {
  const res = await fetch(SCENE_URL);
  expect(res.ok, `${SCENE_URL}: HTTP ${res.status}`).toBe(true);
  const data = await res.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(4, data.byteLength)));
  expect(magic, `${SCENE_URL} is not a GLB (${data.byteLength} B) — LFS pointer or SPA fallback?`).toBe('glTF');

  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  viewer.loop.setPaused(HOLD, true);
  registerAllBehaviors(viewer.behaviors);
  await viewer.loadModel(SCENE_URL, { data, modelName: 'DemoRealvirtualWeb.glb', identityUrl: SCENE_URL });
  await viewer.whenSceneReady();
}, 180_000);

afterAll(() => handle?.dispose());

describe('standard demo — the robot moves within 30 s sim time', () => {
  it('the cell control raises LoadCell and the ReplayRecording drives the robot', () => {
    expect(viewer.loop.isPaused).toBe(true);
    const signals = viewer.signalStore;
    expect(signals, 'the loaded demo has a signal store').not.toBeNull();
    const a2Start = axis('A2');
    let loadCellAt: number | null = null;
    let maxDeltaA2 = 0;
    while (viewer.simTime < SIM_SECONDS) {
      tick();
      if (loadCellAt === null && signals!.get('LoadCell') === true) loadCellAt = viewer.simTime;
      maxDeltaA2 = Math.max(maxDeltaA2, Math.abs(axis('A2') - a2Start));
    }
    const gates = Object.fromEntries(['OnSwitch', 'EmergencyButton', 'AutomaticLight', 'RobotButton']
      .map(n => [n, signals!.get(n)]));
    expect(loadCellAt, `LoadCell never true within ${SIM_SECONDS} s sim; gates ${JSON.stringify(gates)}`).not.toBeNull();
    expect(maxDeltaA2, `A2 did not move (LoadCell at ${loadCellAt?.toFixed(1)} s)`).toBeGreaterThan(5);
  }, 240_000);
});
