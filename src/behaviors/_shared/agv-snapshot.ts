// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { applyPose, travelerIdOf, type AgvLocal, type AgvSelf } from '../Agv';
import { agvStateKeys, agvTaskStateKeys, agvTaskServices } from './agv-state';
import { getDefaultAgvFleet, type AgvTask } from '../../core/engine/rv-agv-fleet';
import { getDefaultPathNetwork } from '../../core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../core/engine/rv-zone-registry';
import { fromSnapshotData, toSnapshotData, type SnapshotJson } from '../../core/engine/rv-snapshot-contract';

export const agvSnapshotSchema = { codecs: { cTime: 'number-tags' } } as const;
type AgvState = Pick<AgvLocal, typeof agvStateKeys[number]>;
function fail(reason: string, code = 'des-snapshot-agv-state'): never {
  throw Object.assign(new Error(`fleet.agv: ${reason}`), { code });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected record');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): void {
  if (Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('unexpected or missing fields');
}
function callbacks(task: AgvTask | null): void {
  if (task && agvTaskServices.some(k => typeof task[k] === 'function') && !getDefaultAgvFleet().taskCodecFor(task))
    fail('task callbacks require Phase 6 reattachment', 'des-snapshot-agv-task-callbacks');
}
function exportTask(task: AgvTask | null): SnapshotJson {
  callbacks(task);
  if (task === null) return null;
  const out: Record<string, unknown> = {};
  for (const key of agvTaskStateKeys) if (Object.hasOwn(task, key)) out[key] = task[key];
  const exportData = getDefaultAgvFleet().taskCodecFor(task)?.exportData;
  if (exportData && Object.hasOwn(out, 'data')) out.data = exportData(task.data);
  return toSnapshotData(out, { participant: 'fleet.agv.task' });
}
function task(value: unknown, vehicleId: string): AgvTask | null {
  if (value === null) return null;
  const t = record(value);
  keys(t, agvTaskStateKeys, ['destination']);
  if (typeof t.destination !== 'string' || !t.destination.length
    || Object.hasOwn(t, 'serviceSec') && (typeof t.serviceSec !== 'number' || !Number.isFinite(t.serviceSec) || t.serviceSec < 0)
    || Object.hasOwn(t, 'serviceState') && typeof t.serviceState !== 'string'
    || Object.hasOwn(t, 'approach') && t.approach !== 'forward' && t.approach !== 'reverse') fail('invalid task');
  // No number tags, classes, aliases, functions or undefined in project payloads.
  const decoded = toSnapshotData(t, { participant: 'fleet.agv.task' }) as unknown as AgvTask;
  const codec = getDefaultAgvFleet().taskCodecFor(decoded);
  const reason = codec?.validate?.(decoded, vehicleId);
  if (reason) fail(reason);
  codec?.attach(decoded);
  return decoded;
}
function path(id: unknown) {
  const p = typeof id === 'string' && getDefaultPathNetwork().get(id);
  if (!p) fail(`unknown maneuver path '${id}'`);
  return p;
}
function integer(value: unknown, min = 0): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail('invalid integer');
}
function decode(json: unknown, vehicleId: string): AgvState {
  const s = record(fromSnapshotData(json, { participant: 'fleet.agv', ...agvSnapshotSchema }));
  keys(s, agvStateKeys);
  for (const k of ['active', 'hiddenByActive', 'dockReleaseFlag', 'lastCanMove', 'frozen'])
    if (typeof s[k] !== 'boolean') fail(`invalid ${k}`);
  for (const k of ['serviceRemainingSec', 'frozenServiceSec'])
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k]) || s[k] < (k === 'frozenServiceSec' ? -1 : 0)) fail(`invalid ${k}`);
  if (typeof s.cTime !== 'number' || !(Number.isFinite(s.cTime) || Number.isNaN(s.cTime))) fail('invalid cTime');
  for (const k of ['stepFrame', 'desServiceEvent']) integer(s[k], -1);
  for (const k of ['maneuverEpoch', 'serviceEpoch']) integer(s[k]);
  if (!['cruising', 'driving', 'servicing', 'idle'].includes(String(s.phase))) fail('invalid phase');
  if (s.serviceMode !== 'timer' && s.serviceMode !== 'dock') fail('invalid serviceMode');
  for (const k of ['servedPathId', 'atNodeId', 'desArrivedPathId'])
    if (s[k] !== null && typeof s[k] !== 'string') fail(`invalid ${k}`);
  s.task = task(s.task, vehicleId);
  if (s.maneuver !== null) {
    const m = record(s.maneuver);
    keys(m, ['stub', 'turn', 'route', 'mergeZone', 'companions', 'stage', 'epoch', 'goAround', 'pending', 'retryLogged']);
    if (!['approach', 'reverse', 'dock'].includes(String(m.stage)) || typeof m.goAround !== 'boolean'
      || typeof m.retryLogged !== 'boolean') fail('invalid maneuver');
    integer(m.epoch);
    if (!Array.isArray(m.route) || m.route.length < 2 || !Array.isArray(m.companions)) fail('invalid maneuver route/zones');
    const zone = (id: unknown): string => {
      if (typeof id !== 'string' || !getDefaultZoneRegistry().has(id)) fail(`unknown maneuver zone '${id}'`);
      return id;
    };
    const companions = m.companions.map(zone);
    const mergeZone = zone(m.mergeZone);
    if (new Set(companions).size !== companions.length || companions.includes(mergeZone)) fail('duplicate maneuver zones');
    const stub = path(m.stub), turn = path(m.turn), route = m.route.map(path);
    if (route[0] !== turn || route[route.length - 1] !== stub || turn.zoneId !== m.mergeZone
      || route.some(p => p.zoneId !== mergeZone && !companions.includes(p.zoneId ?? ''))) fail('inconsistent maneuver references');
    if (m.pending !== null) { const pending = record(m.pending); keys(pending, ['task']); pending.task = task(pending.task, vehicleId); }
    s.maneuver = { ...m, stub, turn, route };
  }
  return s as unknown as AgvState;
}

/** Pure DTO capture. Services and synchronous scratch never enter the payload. */
export function exportAgvState(self: AgvSelf): SnapshotJson {
  const l = self.local;
  if (l.inHook !== false) fail('capture inside hook', 'des-snapshot-agv-busy');
  if (l.kernelKind !== 'des') fail('capture requires DES');
  callbacks(l.startTask);
  callbacks(l.task);
  callbacks(l.maneuver?.pending?.task ?? null);
  const out: Record<string, unknown> = {};
  for (const key of agvStateKeys) out[key] = l[key];
  out.task = exportTask(l.task);
  const m = l.maneuver;
  out.maneuver = m === null ? null : { ...m, stub: m.stub.id, turn: m.turn.id, route: m.route.map(p => p.id),
    companions: [...m.companions], pending: m.pending === null ? null : { task: exportTask(m.pending.task) } };
  const json = toSnapshotData(out, { participant: 'fleet.agv', ...agvSnapshotSchema });
  decode(json, travelerIdOf(self));
  return json;
}
export function validateAgvState(json: unknown, vehicleId: string): readonly string[] {
  try { decode(json, vehicleId); return []; } catch (e) { return [`des-snapshot-agv-state: ${e instanceof Error ? e.message : String(e)}`]; }
}
export function prepareAgvState(self: AgvSelf, json: unknown, vehicleId = travelerIdOf(self)): AgvState {
  if (self.local.kernelKind !== 'des') fail('restore requires DES');
  return decode(json, vehicleId);
}
/** No hooks, routing, scheduling or signal writes at commit. */
export function swapAgvState(self: AgvSelf, prepared: AgvState): void {
  Object.assign(self.local, prepared);
  // Active travelers follow the restored authority pose. Inactive vehicles have no authority entry.
  if (prepared.active) applyPose(self);
}
