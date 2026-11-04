// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { testAddressRegistry } from '../helpers/test-address-registry';
// plan-645 test helper — the headless line Source → Conveyor_1 → Conveyor_2 → Sink
// (same scene as WV tests/des-rebind-scene.test.ts and the plan-645 spike), plus a
// lifecycle recorder. Not a test file.
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { _resetDesHookCache } from '../../src/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import Source from '../../src/behaviors/Source';
import Sink from '../../src/behaviors/Sink';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import {
  _resetMaterialFlowRegistry,
  getMaterialFlow,
  registerMaterialFlow,
} from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { DesLifecycleEvent } from '../../src/core/material-flow/simulation-kernel';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

void Source; void Sink;

export const SIM_TIME_S = 60;
export const MAX_EVENTS = 4000;

export function lineDefs(): MaterialFlowDefinition[] {
  return [
    getMaterialFlow('Source')!,
    getMaterialFlow('Sink')!,
    ConveyorFlow as unknown as MaterialFlowDefinition,
  ];
}

export function resetWorld(): void {
  const defs = lineDefs();
  _resetMaterialFlowRegistry();
  for (const d of defs) registerMaterialFlow(d);
  _resetDesHookCache();
  resetDESMUCounter();
}

export interface Line { scene: Scene; host: BindContextHost; store: SignalStore }

/** The line; names in `unstamped` get no placement stamp (their signals stay unscoped). */
export function line(unstamped: readonly string[] = []): Line {
  const scene = new Scene();
  const drives: BindContextHost['drives'] = [];
  const add = (name: string, payload: Record<string, unknown>, x: number): Object3D => {
    const root = new Object3D();
    root.name = name;
    root.userData.realvirtual = unstamped.includes(name) ? { ...payload } : { ...payload, LayoutObject: { Name: name } };
    root.position.set(x, 0, 0);
    scene.add(root);
    return root;
  };
  const snapAt = (parent: Object3D, name: string, x: number): void => {
    const s = new Object3D(); s.name = name; s.position.set(x, 0, 0); parent.add(s);
  };
  const conveyor = (name: string, x: number): void => {
    const root = add(name, { Conveyor: {} }, x);
    const belt = new Mesh(new BoxGeometry(1, 0.1, 0.4));
    belt.name = 'Transport-X';
    root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
    snapAt(root, 'Snap-XN-convroll', -0.5);
    snapAt(root, 'Snap-XP-convroll', 0.5);
    drives.push({ name: 'Transport-X', node: belt, TargetSpeed: 500 });
  };
  const src = add('Source_1', { Source: { Interval: 2, AutomaticGeneration: true } }, -0.75);
  const body = new Mesh(new BoxGeometry(0.3, 0.05, 0.3)); body.name = 'SourceBody'; src.add(body);
  snapAt(src, 'Snap-XP-convroll', 0.25);
  conveyor('Conveyor_1', 0);
  conveyor('Conveyor_2', 1);
  const snk = add('Sink_1', { Sink: {} }, 1.75);
  const sbody = new Mesh(new BoxGeometry(0.4, 0.4, 0.4)); sbody.name = 'SinkBody'; snk.add(sbody);
  snapAt(snk, 'Snap-XN-convroll', -0.25);
  scene.updateMatrixWorld(true);

  const events = new EventEmitter<Record<string, unknown>>();
  const store = new SignalStore();
  const host = {
    signalStore: store,
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives,
    registry: null, desAddresses: testAddressRegistry(scene),
    getPlugin: () => undefined,
  } as unknown as BindContextHost;
  return { scene, host, store };
}

export function newRunner(): DESRunner {
  return new DESRunner({ subMode: 'fastforward', durationSeconds: SIM_TIME_S, masterSeed: 7 });
}

/** Bound start of the line on a fresh runner. */
export function startLine(): { runner: DESRunner; l: Line } {
  const l = line();
  const runner = newRunner();
  runner.start(lineDefs(), { root: l.scene, host: l.host });
  return { runner, l };
}

/** Records lifecycle events as `type@generation`. */
export function record(runner: DESRunner): { log: string[]; events: DesLifecycleEvent[]; off: () => void } {
  const log: string[] = [];
  const events: DesLifecycleEvent[] = [];
  const off = runner.onLifecycle((e) => { events.push(e); log.push(`${e.type}@${e.generation}`); });
  return { log, events, off };
}

/** A minimal in-memory experiment store (save/load snapshot only; no manifests). */
export function memoryStore(): { writeSnapshot: (...a: unknown[]) => Promise<void>; readSnapshot: (...a: unknown[]) => Promise<unknown>; readManifest: (...a: unknown[]) => Promise<null> } {
  const snaps = new Map<string, unknown>();
  const key = (m: unknown, e: unknown, r: unknown, t: unknown): string => `${m}/${e}/${r}/${t}`;
  return {
    writeSnapshot: async (m, e, r, t, snap) => { snaps.set(key(m, e, r, t), JSON.parse(JSON.stringify(snap))); },
    readSnapshot: async (m, e, r, t) => snaps.get(key(m, e, r, t)) ?? null,
    // V1-I: save/load read the column manifest; a store without manifests answers null.
    readManifest: async () => null,
  };
}
