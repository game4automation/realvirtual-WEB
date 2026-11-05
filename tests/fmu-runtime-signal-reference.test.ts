// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A stored signal reference to an FMU's RUNTIME signal leaf (`<node>/Signals/<variable>`).
 *
 * The leaves are runtime products of `Fmu.init()` (never saved), so no file's authored
 * index knows them: the pre-769 path form (`{ path: 'Ball/Signals/h' }`, the shipped FMU
 * demo) and the web writer's form (`{ unresolvedPath: 'Ball/Signals/h', reason: 'missing' }`)
 * both get a file verdict "miss". The reference still names the leaf EXACTLY (as written,
 * relative to the document's content root), so it binds — exact path, same document, an
 * FMU-stamped leaf, nothing else (contract-node-identity R4: never guessed). A path that
 * only ENDS like a leaf, or names a leaf that does not exist, stays unresolved and is
 * reported (`reference-unresolved`).
 */

import { describe, it, expect } from 'vitest';
import bouncingBallUrl from './fixtures/BouncingBall.fmu?url';
import { bootRealLoaderViewer } from './helpers/nested-placement-fixture';
import { buildFmuDemoGlb } from './helpers/fmu-demo-scene';
import { assembleGlb } from './helpers/glb-fixture';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import { getProblems } from '../src/core/hmi/problems-store';
import type { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';

type GlbJson = { nodes: Array<{ name?: string; extras?: { realvirtual?: Record<string, Record<string, unknown>> } }> };

function splitGlb(glb: ArrayBuffer): { json: GlbJson; bin: Uint8Array | null } {
  const view = new DataView(glb);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen))) as GlbJson;
  const binStart = 20 + jsonLen;
  const bin = binStart + 8 <= glb.byteLength
    ? new Uint8Array(glb.slice(binStart + 8, binStart + 8 + view.getUint32(binStart, true)))
    : null;
  return { json, bin };
}

/** The `signalAddress` of the demo's LogicStep_SetSignalBool (RestartBall), `undefined` without one. */
function restartStepAddress(steps: readonly unknown[]): string | null | undefined {
  for (const s of steps as Array<{ children?: unknown[]; signalAddress?: string | null; value?: unknown }>) {
    if ('signalAddress' in s && typeof s.value === 'boolean') return s.signalAddress;
    const inner = s.children ? restartStepAddress(s.children) : undefined;
    if (inner !== undefined) return inner;
  }
  return undefined;
}

async function load(glb: ArrayBuffer) {
  const booted = await bootRealLoaderViewer();
  const viewer = booted.h.viewer;
  await viewer.loadModel('fmu-demo.glb', { data: glb });
  await viewer.whenSceneReady();
  const follow = viewer.registry!.getAll<RVDriveFollowPosition>('Drive_FollowPosition')[0]?.instance ?? null;
  const restart = restartStepAddress(viewer.logicEngine?.roots ?? []);
  const unresolved = getProblems()
    .filter((p) => p.code === 'reference-unresolved')
    .map((p) => p.title);
  return { booted, viewer, follow, restart, unresolved };
}

const shipped = async (): Promise<ArrayBuffer> => (await fetch('/demo-realvirtual/fmu-demo.glb')).arrayBuffer();

describe('stored signal reference to an FMU runtime signal leaf', () => {
  it('pre-769 path form (shipped demo): Position and the Restart step bind to the exact leaf', async () => {
    const l = await load(await shipped());
    try {
      expect(l.follow?.Position).toBe('FmuDemo/Ball/Signals/h');
      expect(l.restart).toBe('FmuDemo/Ball/Signals/Restart');
      expect(l.unresolved).toEqual([]);
    } finally {
      l.booted.h.dispose();
    }
  }, 30_000);

  it('web-written unresolvedPath form: binds to the exact leaf as well', async () => {
    binaryResources._resetForTesting();
    const bb = new Uint8Array(await (await fetch(bouncingBallUrl)).arrayBuffer());
    const { glb } = await buildFmuDemoGlb(bb);
    const ball = splitGlb(glb).json.nodes.find((n) => n.name === 'Ball')!;
    expect(ball.extras!.realvirtual!.Drive_FollowPosition.Position)
      .toMatchObject({ unresolvedPath: 'Ball/Signals/h' });
    const l = await load(glb);
    try {
      expect(l.follow?.Position).toBe('FmuDemo/Ball/Signals/h');
      expect(l.restart).toBe('FmuDemo/Ball/Signals/Restart');
      expect(l.unresolved).toEqual([]);
    } finally {
      l.booted.h.dispose();
    }
  }, 30_000);

  it('root-prefixed spelling (FmuDemo/Ball/Signals/h) binds to the same exact leaf', async () => {
    const { json, bin } = splitGlb(await shipped());
    const rv = json.nodes.find((n) => n.name === 'Ball')!.extras!.realvirtual!;
    rv.Drive_FollowPosition.Position = { type: 'ComponentReference', path: 'FmuDemo/Ball/Signals/h', componentType: 'PLCOutputFloat' };
    const l = await load(assembleGlb(json as unknown as Record<string, unknown>, bin));
    try {
      expect(l.follow?.Position).toBe('FmuDemo/Ball/Signals/h');
      expect(l.unresolved).toEqual([]);
    } finally {
      l.booted.h.dispose();
    }
  }, 30_000);

  it('counter-test: the FMU-created Signals container is no signal; an address never falls back to a path', async () => {
    const { json, bin } = splitGlb(await shipped());
    const rv = json.nodes.find((n) => n.name === 'Ball')!.extras!.realvirtual!;
    rv.Drive_FollowPosition.Position = { type: 'ComponentReference', unresolvedPath: 'Ball/Signals', reason: 'missing', componentType: 'PLCOutputFloat' };
    const step = json.nodes.find((n) => n.name === 'RestartBall')!.extras!.realvirtual!;
    step.LogicStep_SetSignalBool.Signal = { type: 'ComponentReference', address: '#no-such-node', path: 'Ball/Signals/Restart', componentType: 'PLCInputBool' };
    const l = await load(assembleGlb(json as unknown as Record<string, unknown>, bin));
    try {
      expect(l.follow?.Position ?? null).toBeNull();
      expect(l.restart ?? null).toBeNull();
      expect(l.unresolved).toEqual(expect.arrayContaining([expect.stringContaining('Ball/Signals')]));
    } finally {
      l.booted.h.dispose();
    }
  }, 30_000);

  it('counter-test: a path that only ENDS like a leaf, or names no leaf, stays unresolved and is reported', async () => {
    const { json, bin } = splitGlb(await shipped());
    const rv = json.nodes.find((n) => n.name === 'Ball')!.extras!.realvirtual!;
    // Suffix of the real leaf `Ball/Signals/h` — the SignalStore's suffix matching would bind it.
    rv.Drive_FollowPosition.Position = { type: 'ComponentReference', path: 'Signals/h', componentType: 'PLCOutputFloat' };
    const step = json.nodes.find((n) => n.name === 'RestartBall')!.extras!.realvirtual!;
    // Same leaf name under a node that carries no FMU.
    step.LogicStep_SetSignalBool.Signal = { type: 'ComponentReference', path: 'Sequence/Signals/Restart', componentType: 'PLCInputBool' };
    const l = await load(assembleGlb(json as unknown as Record<string, unknown>, bin));
    try {
      expect(l.follow?.Position ?? null).toBeNull();
      expect(l.restart ?? null).toBeNull();
      expect(l.unresolved).toEqual(expect.arrayContaining([
        expect.stringContaining('Signals/h'),
        expect.stringContaining('Sequence/Signals/Restart'),
      ]));
    } finally {
      l.booted.h.dispose();
    }
  }, 30_000);
});
