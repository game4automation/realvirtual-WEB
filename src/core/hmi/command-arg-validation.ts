// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { CommandError } from './rv-command-registry';

/** Strict command input; the toolbar's partial-entry parser remains forgiving. */
export function parseDesTimeArg(name: string, v: unknown, opts?: { allowInf?: boolean }): number {
  if (opts?.allowInf && v === 'inf') return Infinity;
  if (typeof v !== 'string' || !/^\d+:\d+:\d+:\d+(?:\.\d+)?$/.test(v.trim())) {
    throw new CommandError(`${name} must be DD:HH:MM:SS`);
  }
  const [days, hours, minutes, seconds] = v.trim().split(':').map(Number);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  if (!Number.isFinite(total)) throw new CommandError(`${name} must be DD:HH:MM:SS`);
  return total;
}

export function finiteNumber(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CommandError(`${name} must be a finite number`);
  return v;
}

export function vec3(name: string, v: unknown): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) throw new CommandError(`${name} must contain 3 finite numbers`);
  return [finiteNumber(name, v[0]), finiteNumber(name, v[1]), finiteNumber(name, v[2])];
}

export function rect4(name: string, v: unknown): [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4) throw new CommandError(`${name} must contain 4 finite numbers`);
  const rect: [number, number, number, number] = [
    finiteNumber(name, v[0]), finiteNumber(name, v[1]), finiteNumber(name, v[2]), finiteNumber(name, v[3]),
  ];
  if (rect[2] <= 0 || rect[3] <= 0) throw new CommandError(`${name} width and height must be greater than 0`);
  return rect;
}

export function boolArg(name: string, v: unknown): boolean {
  if (typeof v !== 'boolean') throw new CommandError(`${name} must be a boolean`);
  return v;
}

export function stringArg(name: string, v: unknown): string {
  if (typeof v !== 'string') throw new CommandError(`${name} must be a string`);
  return v;
}

export function stringList(name: string, v: unknown): string[] {
  if (!Array.isArray(v)) throw new CommandError(`${name} must be an array of strings`);
  return Array.from(v, item => stringArg(name, item));
}
