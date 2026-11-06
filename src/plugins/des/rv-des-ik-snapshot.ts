// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D, Quaternion, Vector3 } from 'three';
import { linAvailable, type RVIKPath } from '../../core/engine/rv-ik-path';
import type { RVRobotIK } from '../../core/engine/rv-robot-ik';
import type { RVIKTarget } from '../../core/engine/rv-ik-target';
import type { RVDrive } from '../../core/engine/rv-drive';
import { isDynamicAxis } from '../../core/engine/rv-axis-contract';
import { ikSolverRegistry } from '../../core/engine/rv-ik-solver';
import type { Snapshottable, SnapshotJson, SnapshotSchema } from '../../core/sdk/rv-snapshot-contract-types';
import { fromSnapshotData } from './rv-snapshot-contract';

type AddressOf = (node: Object3D) => string | null;
type Fields = Record<string, unknown>;
type FieldType = 'boolean' | 'integer' | 'number' | 'target' | 'observed' | 'wait' | 'reset' | 'vec3' | 'quat' | 'axes';

const pathFields = {
  PathIsActive: 'boolean', PathIsFinished: 'boolean', WaitForSignal: 'boolean',
  _startSignalValue: 'boolean', _startBefore: 'boolean', _activeMoving: 'boolean',
  _ownershipPaused: 'boolean', _linActive: 'boolean', _linDecel: 'boolean', _ptpRampActive: 'boolean',
  NumTarget: 'integer', _runSeq: 'integer',
  _simTime: 'number', _waitForStartTimer: 'number', _checkNextTargetTimer: 'number',
  _linDist: 'number', _linPos: 'number', _linSpeed: 'number',
  CurrentTarget: 'target', LastTarget: 'target', _linTarget: 'target',
  _observedTarget: 'observed', _waitSignalAddr: 'wait', _pendingReset: 'reset',
  _linStartPos: 'vec3', _linEndPos: 'vec3', _linStartQuat: 'quat', _linEndQuat: 'quat',
  _ptpDest: 'axes', _ptpRampSpeed: 'axes',
} as const satisfies Record<string, FieldType>;

export const ikPathKeyTable = {
  fields: pathFields, stateKeys: Object.keys(pathFields),
  services: [
    'node', 'isOwner', 'SpeedOverride', 'SetNewTCP', 'DrawPath', 'DrawTargets', 'DebugPath',
    'DebugBlending', 'StartPath', 'LoopPath', 'SignalStart', 'SignalIsStarted', 'SignalEnded',
    // The schema mapper adds this authoring list; motion uses resolved _path.
    'Path',
    '_path', '_startNextPath', '_axisDrives', '_robot', '_registry', '_nodePath', '_store', '_writer',
    '_signalStartAddr', '_signalIsStartedAddr', '_signalEndedAddr',
    '_unsubStart', '_ownershipUnregister', '_runListeners',
    // Warn-once diagnostics do not affect motion.
    '_warnedNoDrives',
    // Every solve overwrites warm/seed from the axis positions saved by des.drives.
    '_warm', '_seed',
    // Pose buffers are overwritten before every solver call or interpolation step.
    '_p3', '_q4', '_stepPos', '_stepQuat',
    // The profile output is overwritten from the saved scalar segment state each step.
    '_linProfile',
    // Solver options are populated before every solve; the provider is stateless per call.
    '_cobotOpts',
  ],
};

const fieldsOf = (owner: object): Fields => owner as Fields;
const targetsOf = (path: RVIKPath) => fieldsOf(path)._path as RVIKTarget[];
const axesOf = (path: RVIKPath) => fieldsOf(path)._axisDrives as RVDrive[];
const robotOf = (path: RVIKPath) => fieldsOf(path)._robot as RVRobotIK | null;
const robotKey = (path: RVIKPath) => robotOf(path)?.node.uuid;
function contract(reason: string): never { throw new Error(`des-snapshot-contract: core.ik: ${reason}`); }
function address(path: RVIKPath, addressOf: AddressOf): string {
  const id = addressOf(path.node);
  if (!id) throw Object.assign(new Error('des-snapshot-unaddressable: core.ik owner'), { code: 'des-snapshot-unaddressable' });
  return id;
}

export function ikSnapshotBlockerReason(paths: readonly RVIKPath[], addressOf: AddressOf): string | null {
  const reasons: string[] = [];
  for (const path of paths) if (path.PathIsActive) {
    if (fieldsOf(path)._ownershipPaused) reasons.push(`IK path ${address(path, addressOf)} is paused by an axis owner`);
    if (axesOf(path).some(isDynamicAxis)) reasons.push(`IK path ${address(path, addressOf)} drives dynamic axes`);
  }
  return reasons.sort().join('; ') || null;
}

const schema: SnapshotSchema = { codecs: {
  'paths[].pathLength': 'number-tags', 'paths[].axisCount': 'number-tags',
  ...Object.fromEntries(Object.entries(pathFields).flatMap(([key, type]) => {
    const prefix = `paths[].state.${key}`;
    return type === 'integer' || type === 'number' || type === 'target' ? [[prefix, 'number-tags']]
      : type === 'vec3' || type === 'quat' || type === 'axes' ? [[`${prefix}[]`, 'number-tags']]
        : type === 'reset' ? [[`${prefix}.at`, 'number-tags']] : [];
  })),
} };

function keys(value: unknown, expected: readonly string[], path: string): asserts value is Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
    contract(`${path}: key set mismatch`);
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function numbers(v: unknown, length: number): boolean {
  return Array.isArray(v) && v.length === length && Array.from(v).every(finite);
}
function checkState(value: unknown, path: RVIKPath, label: string): asserts value is Fields {
  keys(value, ikPathKeyTable.stateKeys, label);
  const targets = targetsOf(path), axisCount = axesOf(path).length;
  for (const [key, type] of Object.entries(pathFields)) {
    const v = value[key];
    let valid: boolean;
    switch (type) {
      case 'boolean': valid = typeof v === 'boolean'; break;
      case 'integer': valid = integer(v) && (key !== 'NumTarget' || v <= targets.length); break;
      case 'number': valid = finite(v); break;
      case 'target': valid = v === null || integer(v) && v < targets.length; break;
      case 'observed': valid = v === null || v === 'moved' || v === 'skipped-no-angles'; break;
      case 'wait': valid = v === null || typeof v === 'string' && targets.some(t => t.waitForSignalAddr === v); break;
      case 'reset':
        if (v === null) { valid = true; break; }
        keys(v, ['addr', 'at'], `${label}.${key}`);
        valid = typeof v.addr === 'string' && finite(v.at) && targets.some(t => t.setSignalAddr === v.addr);
        break;
      case 'vec3': valid = numbers(v, 3); break;
      case 'quat': valid = numbers(v, 4); break;
      case 'axes': valid = numbers(v, 0) || numbers(v, axisCount); break;
    }
    if (!valid) contract(`${label}.${key}: invalid ${type}`);
  }
  if (value._linActive && (!value.PathIsActive || value._linTarget === null))
    contract(`${label}: active LIN requires active path and target`);
  if (!value._linActive && value._linTarget !== null)
    contract(`${label}: inactive LIN must have no target`);
  if (value._ptpRampActive && (value._ptpDest as number[]).length !== axisCount)
    contract(`${label}: active PTP ramp requires axis destinations`);
}

export function ikSnapshotParticipant(host: { paths(): readonly RVIKPath[] }, addressOf: AddressOf): Snapshottable {
  const inventory = () => {
    const entries = host.paths().map(owner => ({ owner, address: address(owner, addressOf) }))
      .sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
    if (new Set(entries.map(e => e.address)).size !== entries.length) contract('duplicate owner address');
    return entries;
  };
  const checkClaims = (entries: ReturnType<typeof inventory>) => {
    if (!Number.isFinite(ikSolverRegistry.maxRobots)) return;
    const robots = new Set(entries.map(entry => robotKey(entry.owner)));
    if (ikSolverRegistry.liveSolveClaimKeys().some(key => !robots.has(key)))
      contract('live IK solve claimed by a robot without IK path');
  };
  const prepare = (json: SnapshotJson) => {
    const dto = fromSnapshotData(json, { participant: 'core.ik', ...schema });
    const live = inventory(), claims = new Map<string, boolean>();
    checkClaims(live);
    keys(dto, ['paths'], '$');
    if (!Array.isArray(dto.paths) || dto.paths.length !== live.length) contract('incomplete paths set');
    const rows = dto.paths;
    const writes = live.map((entry, i) => {
      const row: unknown = rows[i], label = `paths[${i}]`;
      keys(row, ['address', 'pathLength', 'axisCount', 'liveSolve', 'state'], label);
      if (row.address !== entry.address) contract(`unknown or unordered path address ${String(row.address)}`);
      if (!integer(row.pathLength) || row.pathLength !== targetsOf(entry.owner).length) contract(`${label}: path length differs`);
      if (!integer(row.axisCount) || row.axisCount !== axesOf(entry.owner).length) contract(`${label}: axis count differs`);
      checkState(row.state, entry.owner, `${label}.state`);
      const uuid = robotKey(entry.owner);
      if (typeof row.liveSolve !== 'boolean' || row.state._linActive && !row.liveSolve) contract(`${label}: invalid liveSolve`);
      // A running LIN segment needs the full solver; a passive claim (e.g. from the IK target editor) only a budget slot.
      if (row.state._linActive ? !linAvailable(robotOf(entry.owner), axesOf(entry.owner).length)
        : row.liveSolve && (!uuid || !ikSolverRegistry.wouldGrantLiveSolve(uuid)))
        contract(`${label}: live IK solver unavailable`);
      if (uuid) {
        if (claims.has(uuid) && claims.get(uuid) !== row.liveSolve) contract(`${label}: robot paths disagree on liveSolve`);
        claims.set(uuid, row.liveSolve);
      }
      return { owner: entry.owner, fields: row.state };
    });
    if ([...claims.values()].filter(Boolean).length > ikSolverRegistry.maxRobots) contract('live IK solver unavailable');
    return { writes, claims };
  };
  return {
    key: 'core.ik', version: 1, dependencies: ['des.signals', 'des.drives'], schema,
    owners: () => inventory().map(entry => ({ path: entry.address, owner: entry.owner,
      stateKeys: ikPathKeyTable.stateKeys, services: ikPathKeyTable.services })),
    capture: () => {
      const live = inventory();
      checkClaims(live);
      return { paths: live.map(entry => {
        const owner = fieldsOf(entry.owner), uuid = robotKey(entry.owner);
        const state = Object.fromEntries(Object.entries(pathFields).map(([key, type]) => {
          const v = owner[key];
          if (type === 'target') {
            const index = v === null ? null : targetsOf(entry.owner).indexOf(v as RVIKTarget);
            if (index === -1) contract(`${entry.address}.${key}: target is not in path`);
            return [key, index];
          }
          return [key, type === 'vec3' || type === 'quat' ? (v as Vector3 | Quaternion).toArray()
            : type === 'axes' ? [...v as number[]] : type === 'reset' && v ? { ...v as Fields } : v];
        }));
        checkState(state, entry.owner, entry.address);
        const liveSolve = !!uuid && ikSolverRegistry.hasLiveSolveClaim(uuid);
        if (state._linActive && !liveSolve) contract(`${entry.address}: invalid liveSolve`);
        return { address: entry.address, pathLength: targetsOf(entry.owner).length,
          axisCount: axesOf(entry.owner).length, liveSolve, state };
      }) };
    },
    validate: json => { try { prepare(json); return []; } catch (error) { return [String(error)]; } },
    prepare,
    commit: prepared => {
      const { writes, claims } = prepared as ReturnType<typeof prepare>;
      for (const { owner, fields } of writes) for (const [key, type] of Object.entries(pathFields)) {
        const v = fields[key], live = fieldsOf(owner);
        if (type === 'vec3') {
          const a = v as [number, number, number];
          (live[key] as Vector3).set(a[0], a[1], a[2]);
        } else if (type === 'quat') {
          const a = v as [number, number, number, number];
          (live[key] as Quaternion).set(a[0], a[1], a[2], a[3]);
        } else if (type === 'axes') {
          const a = live[key] as number[], values = v as number[];
          a.length = values.length;
          for (let i = 0; i < values.length; i++) a[i] = values[i];
        } else live[key] = type === 'target' ? v === null ? null : targetsOf(owner)[v as number] : v;
      }
      for (const [uuid, liveSolve] of claims) if (!liveSolve) ikSolverRegistry.releaseLiveSolve(uuid);
      for (const [uuid, liveSolve] of claims) if (liveSolve) ikSolverRegistry.claimLiveSolve(uuid);
    },
    // Signal subscriptions survive; the restored level and edge baseline need no replay.
  };
}
