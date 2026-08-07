// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.6 remote-matrix + 9.12 remote-races (plan-320 Phase 3).
 *
 * Uses the injectable MultiuserPlugin transport (mock, no real WebSocket) and
 * a minimal fake viewer around a REAL SignalStore:
 *  - 9.6a atomic snapshot: remote ownership is adopted BEFORE the first
 *    snapshot signal dispatch — a listener fired by a snapshot value already
 *    observes non-owner drives and the raised service flag.
 *  - 9.6b remote vs. forced as a before/after pair over the authorityRanking
 *    flag: 'legacy' documents the pre-plan-320 behavior (forced > remote),
 *    'strict' flips it to remote > forced (write-through incl. force pin).
 *  - 9.6c owner-only feedback: a non-owner client (isOwner=false on the
 *    component instance OR the drive) publishes no feedback writes.
 *  - 9.8 rest case: leaveSession() ends remote ownership deterministically
 *    (the model-switch inheritance case lives in model-switch-cleanup.test.ts).
 *  - 9.12a: disconnect/reconnect around a snapshot leaves ownership in a
 *    DEFINED state (still remote-owned; reconnect resumes, leave releases).
 *  - 9.12b: an hmi:force interleaved INTO a running snapshot application
 *    still resolves to the configured ranking (strict: remote wins).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import {
  MultiuserPlugin,
  type MultiuserTransport,
} from '../src/plugins/multiuser-plugin';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  isRemoteOwnershipActive,
  resetSlotAuthority,
  setAuthorityRanking,
} from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import type { RVViewer } from '../src/core/rv-viewer';
import type { RVDrive } from '../src/core/engine/rv-drive';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

// ── Mock transport ──────────────────────────────────────────────────────────

class MockTransport implements MultiuserTransport {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }

  /** Test driver: server accepted the connection. */
  open(): void { this.readyState = 1; this.onopen?.(); }
  /** Test driver: server pushed a message. */
  message(payload: object): void { this.onmessage?.({ data: JSON.stringify(payload) }); }
  /** Test driver: connection dropped. */
  drop(): void { this.readyState = 3; this.onclose?.(); }
}

// ── Fake viewer around a real SignalStore ───────────────────────────────────

interface FakeDrive {
  name: string;
  isOwner: boolean;
  onOwnershipChanged: (owner: boolean) => void;
  applySyncData: (position: number, speed?: number) => void;
  stop: () => void;
}

function makeFakeDrive(name: string): FakeDrive {
  return {
    name,
    isOwner: true,
    onOwnershipChanged: vi.fn(),
    applySyncData: vi.fn(),
    stop: vi.fn(),
  };
}

function makeFixture() {
  const store = new SignalStore();
  store.register('A', 'Cell/A', false, 'PLCOutputBool');
  store.register('B', 'Cell/B', false, 'PLCOutputBool');
  store.register('C', 'Cell/C', false, 'PLCOutputBool');
  const drive = makeFakeDrive('Drive1');
  const viewer = {
    signalStore: store,
    drives: [drive as unknown as RVDrive],
    registry: null,
    playback: null,
    transportManager: null,
    simulationKernel: null,
    scene: null,
    emit: vi.fn(),
  } as unknown as RVViewer;

  const plugin = new MultiuserPlugin();
  const transports: MockTransport[] = [];
  plugin.transportFactory = () => {
    const t = new MockTransport();
    transports.push(t);
    return t;
  };
  plugin.onModelLoaded({} as LoadResult, viewer);
  plugin.joinSession('ws://mock:7000', 'Tester', '#fff', 'observer');
  const transport = transports[0];
  transport.open();
  return { store, drive, viewer, plugin, transport, transports };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.useRealTimers();
  setAuthorityRanking('strict');
  resetSlotAuthority();
});

// ── 9.6a — atomic snapshot ──────────────────────────────────────────────────

describe('remote matrix (9.6)', () => {
  it('9.6a adopts remote ownership BEFORE the first snapshot signal dispatch', () => {
    const { store, drive, plugin, transport } = makeFixture();
    cleanups.push(() => plugin.leaveSession());

    const observed: { ownership: boolean; driveOwner: boolean }[] = [];
    store.subscribe('A', () => {
      observed.push({ ownership: isRemoteOwnershipActive(), driveOwner: drive.isOwner });
    });

    expect(isRemoteOwnershipActive()).toBe(false);
    transport.message({
      type: 'state_snapshot',
      signals: [{ path: 'Cell/A', type: 'bool', value: true }],
      drives: [{ path: 'Drive1', position: 42 }],
      players: [],
    });

    // The FIRST signal listener already sees the remote-owned state.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ ownership: true, driveOwner: false });
    expect(drive.applySyncData).toHaveBeenCalledWith(42, undefined);
  });

  it('9.6b remote vs. forced — before/after pair over the authorityRanking flag', () => {
    const { store, plugin, transport } = makeFixture();
    cleanups.push(() => plugin.leaveSession());

    // Adopt remote ownership (snapshot without the contested signal).
    transport.message({ type: 'state_snapshot', signals: [], drives: [], players: [] });
    expect(isRemoteOwnershipActive()).toBe(true);

    // Operator forces B to false.
    store.forceSignal('B', false);

    // BEFORE (legacy = today's behavior): forced > remote — the remote
    // snapshot write is dropped, the force pin holds.
    setAuthorityRanking('legacy');
    transport.message({
      type: 'state_snapshot',
      signals: [{ path: 'Cell/B', type: 'bool', value: true }],
      drives: [], players: [],
    });
    expect(store.get('B')).toBe(false);
    expect(store.getForcedValue('B')).toBe(false);

    // AFTER (strict = plan-320 target): remote > forced — the remote write
    // passes through the force; value AND pin follow the remote authority.
    setAuthorityRanking('strict');
    transport.message({
      type: 'state_snapshot',
      signals: [{ path: 'Cell/B', type: 'bool', value: true }],
      drives: [], players: [],
    });
    expect(store.get('B')).toBe(true);
    expect(store.isForced('B')).toBe(true);
    expect(store.getForcedValue('B')).toBe(true);
  });

  it('9.6c owner-only feedback — non-owner instance/drive publishes nothing', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const root = new Object3D();
    root.name = 'Conv';
    root.userData.realvirtual = { LayoutObject: { Label: 'Conv' }, Conveyor: {} };
    registry.registerNode('Conv', root);
    const target = scopeSignalName('Conv', 'Flow.Run');
    store.register(target, 'Conv/Flow.Run', false, 'PLCInputBool');
    store.register('Src.Run', '__iface__/Src.Run', false, 'PLCOutputBool');
    const manager = new SignalBindingManager(store, registry);
    manager.bind('Conv', root, {
      slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcInput', enabled: true,
    });
    manager.tick(1 / 60);

    // Owner (default): the standalone legacy write-back reaches the source.
    expect(manager.writeToSource('Conv', 'Flow.Run', true)).toBe(true);
    expect(store.get('Src.Run')).toBe(true);

    // Reach the live binding to flip ownership flags (test-only injection —
    // production sets isOwner via the MultiuserPlugin on real instances).
    const elements = (manager as unknown as {
      _elements: Map<string, { bindings: Map<string, {
        instance: { isOwner?: boolean } | null;
        drive: { isOwner?: boolean } | null;
      }> }>;
    })._elements;
    const binding = [...elements.get('Conv')!.bindings.values()][0];

    // Non-owner COMPONENT INSTANCE → no feedback write.
    binding.instance = { isOwner: false };
    expect(manager.writeToSource('Conv', 'Flow.Run', false)).toBe(false);
    expect(store.get('Src.Run')).toBe(true);

    // Non-owner DRIVE → no feedback write either.
    binding.instance = null;
    binding.drive = { isOwner: false };
    expect(manager.writeToSource('Conv', 'Flow.Run', false)).toBe(false);
    expect(store.get('Src.Run')).toBe(true);

    // Ownership restored → feedback flows again.
    binding.drive = { isOwner: true };
    expect(manager.writeToSource('Conv', 'Flow.Run', false)).toBe(true);
    expect(store.get('Src.Run')).toBe(false);
  });

  it('9.8 rest case — leaveSession ends remote ownership and restores drives', () => {
    const { drive, plugin, transport } = makeFixture();
    transport.message({
      type: 'state_snapshot', signals: [], drives: [{ path: 'Drive1', position: 1 }], players: [],
    });
    expect(isRemoteOwnershipActive()).toBe(true);
    expect(drive.isOwner).toBe(false);

    plugin.leaveSession();
    expect(isRemoteOwnershipActive()).toBe(false);
    expect(drive.isOwner).toBe(true);
  });
});

// ── 9.12 — races ────────────────────────────────────────────────────────────

describe('remote races (9.12)', () => {
  it('9.12a disconnect/reconnect around a snapshot leaves ownership defined', () => {
    vi.useFakeTimers();
    const { drive, plugin, transports } = makeFixture();
    cleanups.push(() => plugin.leaveSession());
    const first = transports[0];

    first.message({
      type: 'state_snapshot', signals: [], drives: [{ path: 'Drive1', position: 5 }], players: [],
    });
    expect(isRemoteOwnershipActive()).toBe(true);
    expect(drive.isOwner).toBe(false);

    // Transport drops right after the snapshot — ownership stays raised
    // (deterministic: the server remains the authority until leave).
    first.drop();
    expect(isRemoteOwnershipActive()).toBe(true);
    expect(drive.isOwner).toBe(false);

    // Auto-reconnect (2 s) produces a fresh transport; the next snapshot
    // resumes the SAME consistent state — no partial/unowned window.
    vi.advanceTimersByTime(2000);
    expect(transports).toHaveLength(2);
    const second = transports[1];
    second.open();
    second.message({
      type: 'state_snapshot', signals: [], drives: [{ path: 'Drive1', position: 6 }], players: [],
    });
    expect(isRemoteOwnershipActive()).toBe(true);
    expect(drive.isOwner).toBe(false);

    // Only an explicit leave releases the authority.
    plugin.leaveSession();
    expect(isRemoteOwnershipActive()).toBe(false);
    expect(drive.isOwner).toBe(true);
  });

  it('9.12b hmi:force interleaved into a running snapshot keeps the strict ranking', () => {
    const { store, plugin, transport } = makeFixture();
    cleanups.push(() => plugin.leaveSession());

    // A listener on the FIRST snapshot signal forces the SECOND one — the
    // force lands mid-application, before the snapshot reaches C.
    let forcedMidSnapshot = false;
    store.subscribe('A', () => {
      if (!forcedMidSnapshot) {
        forcedMidSnapshot = true;
        store.forceSignal('C', false);
      }
    });

    transport.message({
      type: 'state_snapshot',
      signals: [
        { path: 'Cell/A', type: 'bool', value: true },
        { path: 'Cell/C', type: 'bool', value: true },
      ],
      drives: [], players: [],
    });

    // Strict ranking also inside the interleaving window: the remote write to
    // the just-forced C passes through (remote > forced), pin follows.
    expect(forcedMidSnapshot).toBe(true);
    expect(store.get('C')).toBe(true);
    expect(store.isForced('C')).toBe(true);
    expect(store.getForcedValue('C')).toBe(true);
  });
});
