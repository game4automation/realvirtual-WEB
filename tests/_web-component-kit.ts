// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * _web-component-kit.ts — shared fixture for the plan-210 phase-2 tests
 * (reload-cold / reload-teardown / setup-failure-isolation / empty-code /
 * webcomponent-wiring). Builds a mock host world (drive, sensor fan-out,
 * signal map) and an `RVWebComponentRegistry` wired against it, mirroring
 * the sdk-pilot test setup but through the instance registry.
 */

import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import {
  RVWebComponentRegistry,
  parseWebComponent,
  type ParsedWebComponent,
  type WebComponentRegistryOptions,
} from '../src/core/engine/rv-web-component-registry';
import type { SdkDriveTarget, SdkSensorTarget } from '../src/core/sdk/rv-sdk-self';

export const FIXED_DT = 1 / 60;

export interface MockWorld {
  calls: string[];
  drive: SdkDriveTarget;
  sensor: SdkSensorTarget & { fire(occ: boolean): void; readonly subCount: number };
  signals: Map<string, boolean | number>;
  signalSubs: Map<string, Set<(v: boolean | number) => void>>;
  setSignal(name: string, value: boolean | number): void;
  states: string[];
}

export function makeWorld(): MockWorld {
  const calls: string[] = [];
  const drive: SdkDriveTarget = {
    currentPosition: 0,
    currentSpeed: 0,
    targetSpeed: 100,
    isAtTarget: true,
    jogForward: false,
    jogBackward: false,
    startMove(destination?: number) { calls.push(`moveTo(${destination})`); },
    stop() { calls.push('stop'); },
  };
  const subs = new Set<(occ: boolean) => void>();
  const sensor: MockWorld['sensor'] = {
    occupied: false,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    fire(occ: boolean) { for (const cb of [...subs]) cb(occ); },
    get subCount() { return subs.size; },
  };
  const signals = new Map<string, boolean | number>();
  const signalSubs = new Map<string, Set<(v: boolean | number) => void>>();
  const setSignal = (name: string, value: boolean | number): void => {
    signals.set(name, value);
    const listeners = signalSubs.get(name);
    if (listeners) for (const cb of [...listeners]) cb(value);
  };
  return { calls, drive, sensor, signals, signalSubs, setSignal, states: [] };
}

export interface KitOptions {
  emit?: WebComponentRegistryOptions['emit'];
  onInstanceDisabled?: WebComponentRegistryOptions['onInstanceDisabled'];
  /** Extra per-instance hook (e.g. trigger a reload from inside a tick). */
  onSetState?: (nodePath: string, state: string) => void;
}

export function makeRegistry(host: RVScriptHost, world: MockWorld, opts: KitOptions = {}): RVWebComponentRegistry {
  const registry: RVWebComponentRegistry = new RVWebComponentRegistry({
    host,
    callDeadlineMs: 200,
    emit: opts.emit,
    onInstanceDisabled: opts.onInstanceDisabled,
    buildEnv: ({ nodePath, nodeName, node, props, scheduler }) => ({
      name: nodeName,
      path: nodePath,
      node,
      props,
      components: {
        drive: (p) => (p === 'Gate/Drive' ? world.drive : null),
        sensor: (p) => (p === 'Gate/Sensor' ? world.sensor : null),
      },
      signals: {
        get: (n) => world.signals.get(n),
        set: (n, v) => world.setSignal(n, v),
        subscribe: (n, cb) => {
          let set = world.signalSubs.get(n);
          if (!set) { set = new Set(); world.signalSubs.set(n, set); }
          set.add(cb);
          return () => set!.delete(cb);
        },
      },
      scheduler,
      onSetState: (s) => {
        world.states.push(s);
        opts.onSetState?.(nodePath, s);
      },
      log: () => {},
    }),
  });
  return registry;
}

export function meta(code: string, overrides: Partial<ParsedWebComponent> = {}): ParsedWebComponent {
  const parsed = parseWebComponent({ Code: code })!;
  return { ...parsed, ...overrides };
}

export function makeNode(name: string): Object3D {
  const node = new Object3D();
  node.name = name;
  return node;
}

export function tickSeconds(registry: RVWebComponentRegistry, seconds: number): void {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) registry.tickAll(FIXED_DT);
}
