// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { VehicleStatusFlags } from './vehicle-status';

export type LampRole = 'StackGreen' | 'StackAmber' | 'StackRed' | 'Beacon' | 'EyeL' | 'EyeR';
export const LAMP_ROLES: readonly LampRole[] = ['StackGreen', 'StackAmber', 'StackRed', 'Beacon', 'EyeL', 'EyeR'];

export type LampState = 'off' | 'on' | 'blink';
export interface DisplayedLampState { on: boolean; flashing: boolean }
export interface LampMap {
  green(s: VehicleStatusFlags): LampState;
  yellow(s: VehicleStatusFlags): LampState;
  red(s: VehicleStatusFlags): LampState;
  beacon(s: VehicleStatusFlags): LampState;
  eyes(s: VehicleStatusFlags): 'white' | 'fault';
}
export const DEFAULT_LAMP_MAP: LampMap = {
  green: s => s.fault || s.charging || s.handling ? 'off' : s.orderActive ? 'blink' : s.free ? 'on' : 'off',
  yellow: s => s.fault ? 'off' : s.charging ? 'blink' : s.handling ? 'on' : 'off',
  red: s => s.fault ? 'on' : 'off',
  beacon: s => s.moving ? 'blink' : 'off',
  eyes: s => s.fault ? 'fault' : 'white',
};
export function resolveLampMap(override?: Partial<LampMap>): LampMap {
  return { ...DEFAULT_LAMP_MAP, ...override };
}
const OFF = { on: false, flashing: false }, ON = { on: true, flashing: false }, BLINK = { on: true, flashing: true };
const displayed = (state: LampState): DisplayedLampState => state === 'blink' ? BLINK : state === 'on' ? ON : OFF;
export function lampStatesOf(s: VehicleStatusFlags, map: LampMap = DEFAULT_LAMP_MAP): Record<LampRole, DisplayedLampState> {
  const eyes = map.eyes(s) === 'white' ? ON : OFF;
  return { StackGreen: displayed(map.green(s)), StackAmber: displayed(map.yellow(s)),
    StackRed: displayed(map.red(s)), Beacon: displayed(map.beacon(s)), EyeL: eyes, EyeR: eyes };
}

/** Displayed lit state of a lamp at sim time `t` (blink: first half of the period lit). */
export function litAt(state: DisplayedLampState, t: number, periodSec: number): boolean {
  if (!state.on) return false;
  if (!state.flashing) return true;
  const p = periodSec > 0 && Number.isFinite(periodSec) ? periodSec : 1;
  const phase = ((t % p) + p) % p;
  return phase < p / 2;
}

/** The part of an `RVLamp` this module drives (`node.userData._rvLamp`). */
export interface LampLike {
  Period: number;
  LampOn: boolean;
  Flashing: boolean;
  setDisplayedLit(lit: boolean): boolean;
}

export interface LampNames { green: string; yellow: string; red: string; beacon: string; eye: string }
const candidates = {
  StackGreen: ['Lamp_Green', 'Lamp_StackGreen'], StackAmber: ['Lamp_Yellow', 'Lamp_StackAmber'],
  StackRed: ['Lamp_Red', 'Lamp_StackRed'], Beacon: ['Lamp_Beacon'],
};
/** Arrays retain every matching lamp, including all eyes and duplicate-suffixed nodes. */
export function findLamps(root: Object3D, names: Partial<LampNames> = {}): Map<LampRole, LampLike[]> {
  const out = new Map<LampRole, LampLike[]>();
  const add = (role: LampRole, lamp: LampLike) => {
    const list = out.get(role);
    if (list) list.push(lamp); else out.set(role, [lamp]);
  };
  root.traverse(node => {
    const lamp = node.userData._rvLamp as LampLike | undefined;
    if (!lamp) return;
    const name = node.name.replace(/_\d+$/, '');
    for (const [role, color] of [['StackGreen', 'green'], ['StackAmber', 'yellow'], ['StackRed', 'red'], ['Beacon', 'beacon']] as const) {
      if (names[color] !== undefined ? name === names[color] : candidates[role].includes(name)) { add(role, lamp); return; }
    }
    if (names.eye !== undefined ? name === names.eye : name.startsWith('Lamp_Eye')) add(name === 'Lamp_EyeR' ? 'EyeR' : 'EyeL', lamp);
  });
  return out;
}
