// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import type { CompactRecording } from '../src/core/engine/rv-drives-playback';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { CR, node, sceneToGlb } from './helpers/migrate-769-fixtures';

const MODEL = 'ReplayRoundtrip';
const START = 'replay.start';
const STATUS = 'replay.status';

async function editorLoad(data: ArrayBuffer, url: string) {
  return loadGLB(url, new Scene(), {
    data: data.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false,
  });
}

type Model = Awaited<ReturnType<typeof editorLoad>>;
const loadedModels: Model[] = [];

describe('replay recording signals after a browser save', () => {
  afterEach(() => {
    for (const model of loadedModels.splice(0)) {
      for (const drive of model.drives) drive.dispose();
      model.root.removeFromParent();
    }
    resetProblemsForTests();
  });

  it('resolves saved start and status addresses and starts the sequence on its signal', async () => {
    const scene = new Scene();
    scene.name = MODEL;
    const signals = node('Signals');
    signals.add(
      node('Start', { PLCInputBool: { Name: START, Status: { Value: false } } }),
      node('Status', { PLCInputBool: { Name: STATUS, Status: { Value: false } } }),
    );
    const recording: CompactRecording = {
      fixedDeltaTime: 0.2, numberFrames: 24, driveCount: 1,
      drives: [{ id: 0, path: `${MODEL}/Axis` }],
      positions: Array.from({ length: 24 }, (_, i) => i * 1.25),
      sequences: [{ name: 'Run', startFrame: 3, endFrame: 19 }],
    };
    scene.add(
      node('Axis', { Drive: { Direction: 'LinearX', TargetSpeed: 0 } }),
      node('Recorder', {
        DrivesRecording_compact: recording,
        DrivesRecorder: { PlayOnStart: false, Loop: false, Active: 'Always' },
        ReplayRecording: {
          Sequence: 'Run', Active: 'Always',
          StartOnSignal: CR('Signals/Start', 'realvirtual.PLCInputBool'),
          IsReplayingSignal: CR('Signals/Status', 'realvirtual.PLCInputBool'),
        },
      }),
      signals,
    );
    const original = await editorLoad(await sceneToGlb(scene), 'replay-original.glb');
    loadedModels.push(original);
    expect(original.replayRecordings).toHaveLength(1);
    expect(original.replayRecordings[0].startOnSignalAddr).not.toBeNull();
    expect(original.replayRecordings[0].isReplayingSignalAddr).not.toBeNull();

    const saved = await exportAssetGlb(original.root, MODEL, undefined, undefined, { registry: original.registry });
    const reopened = await editorLoad(saved, 'replay-web-saved.glb');
    loadedModels.push(reopened);
    expect(reopened.replayRecordings).toHaveLength(1);
    const replay = reopened.replayRecordings[0];
    const refs = reopened.root.getObjectByName('Recorder')!.userData.realvirtual.ReplayRecording;
    for (const [field, name, address] of [
      ['StartOnSignal', 'Start', replay.startOnSignalAddr],
      ['IsReplayingSignal', 'Status', replay.isReplayingSignalAddr],
    ] as const) {
      const target = reopened.root.getObjectByName(name)!;
      expect(target).toBeDefined();
      const storedAddress = reopened.registry.getAddressForNode(target);
      expect(storedAddress).toMatch(/^#/);
      // Exact equality proves the saved reference has no legacy path fallback.
      expect(refs[field]).toEqual({
        type: 'ComponentReference', componentType: 'realvirtual.PLCInputBool', address: storedAddress,
      });
      expect(address).not.toBeNull();
      expect(address).toBe(reopened.registry.getPathForNode(target));
    }

    const playback = reopened.playback!;
    expect(playback).not.toBeNull();
    replay.fixedUpdate(0.2);
    expect(playback.isPlaying).toBe(false);
    expect(reopened.signalStore.get(STATUS)).toBe(false);
    reopened.signalStore.setByPath(replay.startOnSignalAddr!, true);
    replay.fixedUpdate(0.2);
    expect(playback.isPlaying).toBe(true);
    expect(playback.frame).toBe(3);
    expect(replay.isActive).toBe(true);
    expect(reopened.signalStore.get(STATUS)).toBe(true);
  });
});
