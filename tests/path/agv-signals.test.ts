// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.7 — Agv signal contract (F9): `Run/Moving/Position/AtNode` are
 * published by the internal simulation; when the component is PLC-wired
 * (`self.isWired`) the internal sim stays SILENT (live values authoritative,
 * no double writes). Headless: real Agv library component bound via
 * `createBindContext`, ticked via `iterateFixedUpdate` — no GLB/DOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import {
  createBindContext,
  applyKinematicsSpec,
  iterateFixedUpdate,
  type BindContextHost,
  type BindContextHandle,
  type KinematicsSpec,
} from '../../src/core/behavior-runtime';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { setSignalLiveControlled, clearLiveControl } from '../../src/core/engine/rv-live-control';
import AgvBehavior from '../../src/behaviors/Agv';

const TICK = 1 / 60;

interface Host extends BindContextHost {
  /** Raw store values for direct assertions. */
  values: Map<string, boolean | number>;
}

function makeHost(): Host {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    values,
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
}

/** An Agv root with a child node carrying a straight 10 m rv_extras.Path. */
function makeAgvRoot(name: string, pathName: string): Object3D {
  const root = new Object3D();
  root.name = name;
  // No ramp → deterministic speed steps (1000 mm/s from the first tick).
  root.userData.realvirtual = { Agv: { TargetSpeed: 1000, UseAcceleration: false } };
  const pathNode = new Object3D();
  pathNode.name = pathName;
  pathNode.userData.realvirtual = {
    Path: {
      type: 'Path',
      version: 1,
      segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 10] }],
    },
  };
  root.add(pathNode);
  return root;
}

function bindAgv(root: Object3D, host: Host): BindContextHandle {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  AgvBehavior.bind(ctx);
  applyKinematicsSpec(root, accum);
  return handle;
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultSpacingController().clear(); // Phase 2: setup joins the headway fleet
  clearLiveControl();
});
afterEach(() => {
  clearLiveControl();
});

describe('Agv signals — Run/Moving/Position/AtNode published (F9)', () => {
  it('setup asserts Run=true and places the vehicle at the path start', () => {
    const host = makeHost();
    const root = makeAgvRoot('Agv01', 'Route01');
    bindAgv(root, host);
    expect(host.values.get('Agv.Run')).toBe(true);
    expect(root.position.z).toBeCloseTo(0, 9);
  });

  it('publishes Moving/Position while driving; Position in mm (drive parity)', () => {
    const host = makeHost();
    const root = makeAgvRoot('Agv01', 'Route01');
    const handle = bindAgv(root, host);

    for (let i = 0; i < 60; i++) iterateFixedUpdate(handle, TICK); // 1 s @ 1000 mm/s
    expect(host.values.get('Agv.Moving')).toBe(true);
    expect(host.values.get('Agv.Position') as number).toBeCloseTo(1000, 3);
    expect(host.values.get('Agv.AtNode')).toBe(false); // mid-path — no node
    expect(root.position.z).toBeCloseTo(1, 6);          // pose follows the path
  });

  it('Run=false stops the vehicle (Moving=false, Position frozen)', () => {
    const host = makeHost();
    const root = makeAgvRoot('Agv01', 'Route01');
    const handle = bindAgv(root, host);

    for (let i = 0; i < 30; i++) iterateFixedUpdate(handle, TICK);
    host.signalStore!.set('Agv.Run', false);
    iterateFixedUpdate(handle, TICK);
    const frozen = host.values.get('Agv.Position') as number;
    expect(host.values.get('Agv.Moving')).toBe(false);
    for (let i = 0; i < 30; i++) iterateFixedUpdate(handle, TICK);
    expect(host.values.get('Agv.Position')).toBe(frozen);
  });

  it('pulses AtNode ONCE at the path end and stops (dead end, no crash)', () => {
    const host = makeHost();
    const root = makeAgvRoot('Agv01', 'Route01');
    const handle = bindAgv(root, host);

    let atNodePulses = 0;
    host.signalStore!.subscribe('Agv.AtNode', (v) => { if (v === true) atNodePulses++; });

    for (let i = 0; i < 620; i++) iterateFixedUpdate(handle, TICK); // 10 m / 1 m/s + margin
    expect(host.values.get('Agv.Position') as number).toBeCloseTo(10000, 3);
    expect(host.values.get('Agv.Moving')).toBe(false);
    expect(host.values.get('Agv.AtNode')).toBe(false); // pulse cleared again
    expect(atNodePulses).toBe(1);                      // exactly one arrival
    expect(root.position.z).toBeCloseTo(10, 6);
  });
});

describe('Agv signals — self.isWired override (live values authoritative)', () => {
  it('when wired, the internal sim writes NO signals and does not move the vehicle', () => {
    // Any live-controlled signal + standalone (unscoped) root → self.isWired.
    setSignalLiveControlled('Agv01W.Transport.Forward', true);

    const host = makeHost();
    const root = makeAgvRoot('Agv01W', 'Route01W');
    const handle = bindAgv(root, host);

    // setup stayed silent: Run was NOT forced on
    expect(host.values.get('Agv.Run')).toBeUndefined();

    const zAfterBind = root.position.z;
    for (let i = 0; i < 120; i++) iterateFixedUpdate(handle, TICK);

    expect(host.values.get('Agv.Moving')).toBeUndefined();
    expect(host.values.get('Agv.Position')).toBeUndefined();
    expect(host.values.get('Agv.AtNode')).toBeUndefined();
    expect(root.position.z).toBe(zAfterBind); // no internal motion
  });

  it('unwired again → the internal sim takes over (no stale silence)', () => {
    const host = makeHost();
    const root = makeAgvRoot('Agv02', 'Route02');
    const handle = bindAgv(root, host);
    host.signalStore!.set('Agv.Run', true);

    setSignalLiveControlled('X.Live', true);
    for (let i = 0; i < 30; i++) iterateFixedUpdate(handle, TICK);
    expect(host.values.get('Agv.Moving')).toBeUndefined(); // silent while wired

    clearLiveControl();
    for (let i = 0; i < 30; i++) iterateFixedUpdate(handle, TICK);
    expect(host.values.get('Agv.Moving')).toBe(true);      // sim resumed
    expect((host.values.get('Agv.Position') as number) > 0).toBe(true);
  });
});
