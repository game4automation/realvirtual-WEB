// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { CoreSubsystems, type CoreSubsystemsHost } from '../../src/core/engine/rv-core-subsystems';
import { RVLogicEngine } from '../../src/core/engine/rv-logic-engine';
import { RVDelay, RVSerialContainer } from '../../src/core/engine/rv-logic-step';
import { DesSnapshotBlockers } from '../../src/core/material-flow/des-snapshot-blockers';
import { getProblems } from '../../src/core/hmi/problems-store';
import { lineFixture as rawLineFixture } from './runner-fixture';

// Every fixture viewer owns a blocker registry, like `RVViewer.snapshotBlockers`.
function lineFixture() {
  const f = rawLineFixture();
  const blockers = new DesSnapshotBlockers();
  Object.assign(f.host, { snapshotBlockers: blockers });
  return Object.assign(f, { blockers });
}


it('lists all reasons, checks restore before mutation, and unregisters independently', () => {
  const f = lineFixture();
  const before = f.snapshot();
  const offA = f.blockers.register('test-a', () => 'active A');
  const offB = f.blockers.register('test-b', () => 'active B');
  try {
    expect(f.blockers.reasons()).toEqual(expect.arrayContaining(['test-a: active A', 'test-b: active B']));
    expect(() => f.snapshot()).toThrow(/active A.*active B/);
    expect(() => f.restore(before)).toThrow(/des-snapshot-unsupported-component/);
    expect(getProblems().some(p => p.code === 'des-snapshot-unsupported-component')).toBe(true);
  } finally { offA(); offB(); }
  expect(f.snapshot()).toEqual(before);
});

it('started LogicStep roots refuse with their name; idle roots allow capture', () => {
  const engine = new RVLogicEngine();
  const root = new RVSerialContainer([new RVDelay(20)]);
  root.name = 'WeldingSequence'; engine.roots.push(root);
  const f = lineFixture();
  const core = new CoreSubsystems({ logicEngine: engine, ikPaths: [], playback: null, replayRecordings: [], snapshotBlockers: f.blockers } as unknown as CoreSubsystemsHost);
  try {
    expect(() => f.snapshot()).not.toThrow();
    engine.start(false);
    expect(() => f.snapshot()).toThrow(/WeldingSequence/);
    engine.reset();
    expect(() => f.snapshot()).not.toThrow();
  } finally { core.dispose(); }
});

it.each(['IK', 'playback', 'replay'] as const)('blocks active %s and releases on disposal', component => {
  const f = lineFixture();
  const core = new CoreSubsystems({
    snapshotBlockers: f.blockers,
    logicEngine: null,
    ikPaths: component === 'IK' ? [{ PathIsActive: true }] : [],
    playback: component === 'playback' ? { isPlaying: true } : null,
    replayRecordings: component === 'replay' ? [{ isActive: true }] : [],
  } as unknown as CoreSubsystemsHost);
  try { expect(() => f.snapshot()).toThrow(/des-snapshot-unsupported-component/); }
  finally { core.dispose(); }
  expect(() => f.snapshot()).not.toThrow();
});

// plan-2059 O7: the registry belongs to ONE viewer. A blocker of viewer 1 must neither refuse the snapshot of viewer 2
// nor be released by it.
it('a blocker of one viewer does not couple to a second viewer on the same page', () => {
  const one = lineFixture();
  const two = lineFixture();
  const off = one.blockers.register('plc', () => 'PLC programs running: Main');
  try {
    expect(() => one.snapshot()).toThrow(/PLC programs running/);
    expect(() => two.snapshot()).not.toThrow();
    expect(two.blockers.reasons()).toEqual([]);
    const before = two.snapshot();
    expect(() => two.restore(before)).not.toThrow();
  } finally { off(); }
  expect(() => one.snapshot()).not.toThrow();
});

it('CoreSubsystems of one viewer block only that viewer', () => {
  const one = lineFixture();
  const two = lineFixture();
  const core = new CoreSubsystems({ logicEngine: null, ikPaths: [{ PathIsActive: true }], playback: null, replayRecordings: [],
    snapshotBlockers: one.blockers } as unknown as CoreSubsystemsHost);
  try {
    expect(() => one.snapshot()).toThrow(/active IK path/);
    expect(() => two.snapshot()).not.toThrow();
  } finally { core.dispose(); }
});
