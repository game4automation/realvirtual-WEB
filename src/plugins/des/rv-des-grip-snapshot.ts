// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D, Vector3 } from 'three';
import type { RVGrip } from '../../core/engine/rv-grip';
import type { RVZone } from '../../core/engine/rv-zone';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { slotBound } from '../../core/engine/rv-slot-io';
import type { Snapshottable, SnapshotJson, SnapshotSchema } from '../../core/sdk/rv-snapshot-contract-types';
import { fromSnapshotData } from './rv-snapshot-contract';

export interface GripSnapshotHost {
  grips(): readonly RVGrip[];
  zones(): readonly RVZone[];
}
type AddressOf = (node: Object3D) => string | null;
type Fields = Record<string, unknown>;
type FieldType = 'boolean' | 'number' | 'nan-number' | 'vec3';

const gripFields = {
  waitingForPart: 'boolean', pickObjects: 'boolean', placeObjects: 'boolean',
  _pickObjectsBefore: 'boolean', _placeObjectsBefore: 'boolean', _velSamples: 'number',
  velocity: 'vec3', _velPrev: 'vec3', _velCur: 'vec3',
} as const;
const zoneFields = {
  active: 'boolean', occupied: 'boolean', _wasActive: 'boolean', _signalLevel: 'boolean',
  _activationBound: 'boolean', _prevAxisPos: 'nan-number', _released: 'boolean', _releaseUsed: 'boolean',
} as const;

export const gripKeyTable = {
  fields: gripFields, stateKeys: Object.keys(gripFields), held: ['grippedMUs', '_seatProblemIds'],
  services: [
    'node', 'isOwner', 'GripRange', 'OneBitControl', 'PlaceMode', 'GripTargetSearchRadius',
    'SignalPick', 'SignalPlace', 'PartToGrip', 'DirectlyGrip', 'PickAlignWithObject', 'AlignRotation',
    'pickAlignNode', 'signalPickAddr', 'signalPlaceAddr', 'partToGripSensor', 'signalStore',
    'collisionRegistrar', 'allMUs', 'allGrips', 'allGripTargets', 'loadHost', 'physicsHost', 'muHost',
    // MU-keyed refusal caches have no observable entries without held MUs.
    'refusedTargets', 'refusedOwners', 'signalUnsubs', '_directListener', 'onHeldChange',
    // Warn-once flags affect diagnostics only, never pick/place decisions.
    '_instancedWarned', '_physicsFallbackWarned',
  ],
};
export const zoneKeyTable = {
  fields: zoneFields, stateKeys: Object.keys(zoneFields), held: ['held', '_token'],
  services: [
    'node', 'isOwner', 'Center', 'Size', 'Detect', 'Block', 'Hold', 'Activation', 'ActivationSignal',
    'InvertSignal', 'ActivationDrive', 'AxisFrom', 'AxisTo', 'SignalOccupied', 'HoldAcquire',
    'HoldCount', 'GripTargetSearchRadius', 'ShowGizmo', 'SingleRelease',
    // Bounds are derived from configuration and node pose; DES never ticks transport.
    'bounds', 'localBounds',
    // Home pose is established by init; these are geometry caches, not DES runtime state.
    '_homeMatrix', '_homeMatrixValid', '_homeBounds', '_homeValid',
    'occupiedListeners', '_writer', '_manager', '_collision', '_unsubs',
    // Warning and gizmo caches affect presentation only.
    '_scaleWarned', '_gizmoManager', '_edges', '_faces', '_visualKey', '_edgeOpts', '_faceOpts',
  ],
};

function contract(reason: string): never { throw new Error(`des-snapshot-contract: core.grip: ${reason}`); }
const fieldsOf = (owner: object): Fields => owner as Fields;

const heldListeners = new WeakMap<RVGrip, Set<() => void>>();
const heldDispatchers = new WeakMap<RVGrip, () => void>();

export function addGripHeldListener(grip: RVGrip, fn: () => void): () => void {
  let listeners = heldListeners.get(grip);
  if (grip.onHeldChange !== (heldDispatchers.get(grip) ?? null)) contract('foreign onHeldChange callback');
  if (!listeners) {
    const subscribed = new Set<() => void>();
    listeners = subscribed;
    const dispatch = () => { for (const listener of subscribed) listener(); };
    heldListeners.set(grip, listeners);
    heldDispatchers.set(grip, dispatch);
    grip.onHeldChange = dispatch;
  }
  listeners.add(fn);
  const subscribed = listeners;
  return () => {
    if (!subscribed.delete(fn) || subscribed.size) return;
    if (grip.onHeldChange === heldDispatchers.get(grip)) grip.onHeldChange = null;
    heldListeners.delete(grip);
    heldDispatchers.delete(grip);
  };
}

/** Reset transport history, then restore the levels normally supplied by signal setters. */
export function resetGripOwners(host: GripSnapshotHost, store: SignalStore | null): void {
  for (const grip of host.grips()) {
    grip.reset();
    (fieldsOf(grip)._velPrev as Vector3).set(0, 0, 0);
    (fieldsOf(grip)._velCur as Vector3).set(0, 0, 0);
    if (grip.signalPickAddr) grip.pickObjects = store?.getByPath(grip.signalPickAddr) === true;
    if (grip.signalPlaceAddr) grip.placeObjects = store?.getByPath(grip.signalPlaceAddr) === true;
  }
  for (const zone of host.zones()) {
    zone.reset();
    if (zone.Activation === 'Signal') {
      const address = zone.ActivationSignal;
      // The setter keeps the raw level; beginTick applies InvertSignal.
      fieldsOf(zone)._signalLevel = !!address && store?.getByPath(address) === true;
      fieldsOf(zone)._activationBound = slotBound(zone, 'ActivationSignal', address);
    }
  }
}

function address(node: Object3D, addressOf: AddressOf): string {
  const id = addressOf(node);
  if (!id) throw Object.assign(new Error('des-snapshot-unaddressable: core.grip owner'), { code: 'des-snapshot-unaddressable' });
  return id;
}

export function gripSnapshotBlockerReason(host: GripSnapshotHost, addressOf: AddressOf): string | null {
  const reasons: string[] = [];
  for (const grip of host.grips()) {
    const n = grip.grippedMUs.length + ((fieldsOf(grip)._seatProblemIds as Set<string>).size > 0 ? 1 : 0);
    if (n) reasons.push(`Grip ${address(grip.node, addressOf)} holds ${n} MU (needs DES MU activation, plan-519)`);
  }
  for (const zone of host.zones()) {
    const n = zone.held.length + (fieldsOf(zone)._token ? 1 : 0);
    if (n) reasons.push(`Zone ${address(zone.node, addressOf)} holds ${n} MU (needs DES MU activation, plan-519)`);
  }
  return reasons.sort().join('; ') || null;
}

const schema: SnapshotSchema = { codecs: {
  'grips[].state._velSamples': 'number-tags',
  'grips[].state.velocity[]': 'number-tags', 'grips[].state._velPrev[]': 'number-tags',
  'grips[].state._velCur[]': 'number-tags', 'zones[].state._prevAxisPos': 'number-tags',
} };
function keys(value: unknown, expected: readonly string[], path: string): asserts value is Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
    contract(`${path}: key set mismatch`);
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function checkFields(value: unknown, types: Record<string, FieldType>, path: string): asserts value is Fields {
  keys(value, Object.keys(types), path);
  for (const [key, type] of Object.entries(types)) {
    const v = value[key];
    const valid = type === 'boolean' ? typeof v === 'boolean' : type === 'number' ? finite(v)
      : type === 'nan-number' ? typeof v === 'number' && (Number.isFinite(v) || Number.isNaN(v))
        : Array.isArray(v) && v.length === 3 && finite(v[0]) && finite(v[1]) && finite(v[2]);
    if (!valid) contract(`${path}.${key}: invalid ${type}`);
  }
}

export function gripSnapshotParticipant(host: GripSnapshotHost, addressOf: AddressOf): Snapshottable {
  const inventory = () => {
    const entries = <T extends RVGrip | RVZone>(owners: readonly T[], table: typeof gripKeyTable | typeof zoneKeyTable) =>
      owners.map(owner => ({ owner, address: address(owner.node, addressOf), table }))
        .sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
    const live = { grips: entries(host.grips(), gripKeyTable), zones: entries(host.zones(), zoneKeyTable) };
    const all = [...live.grips, ...live.zones];
    if (new Set(all.map(entry => entry.address)).size !== all.length) contract('duplicate owner address');
    return live;
  };
  const prepare = (json: SnapshotJson) => {
    const dto = fromSnapshotData(json, { participant: 'core.grip', ...schema });
    const live = inventory();
    keys(dto, ['grips', 'zones'], '$');
    return (['grips', 'zones'] as const).flatMap(kind => {
      const rows = dto[kind];
      if (!Array.isArray(rows) || rows.length !== live[kind].length) contract(`incomplete ${kind} set`);
      return live[kind].map((entry, i) => {
        const row: unknown = rows[i];
        keys(row, ['address', 'state'], `${kind}[${i}]`);
        if (row.address !== entry.address) contract(`unknown or unordered ${kind} address ${String(row.address)}`);
        checkFields(row.state, entry.table.fields, `${kind}[${i}].state`);
        return { owner: entry.owner, fields: row.state, types: entry.table.fields };
      });
    });
  };
  return {
    key: 'core.grip', version: 1, dependencies: ['des.signals'], schema,
    owners: () => {
      const live = inventory();
      return [...live.grips, ...live.zones].map(entry => ({
        path: entry.address, owner: entry.owner, stateKeys: entry.table.stateKeys,
        // Held fields are owned but refused at the runner boundary by core.grip's blocker.
        services: [...entry.table.held, ...entry.table.services],
      }));
    },
    capture: () => {
      const live = inventory();
      const rows = (entries: typeof live.grips | typeof live.zones) => entries.map(entry => ({
        address: entry.address,
        state: Object.fromEntries(Object.entries(entry.table.fields).map(([key, type]) =>
          [key, type === 'vec3' ? (fieldsOf(entry.owner)[key] as Vector3).toArray() : fieldsOf(entry.owner)[key]])),
      }));
      return { grips: rows(live.grips), zones: rows(live.zones) };
    },
    validate: json => { try { prepare(json); return []; } catch (error) { return [String(error)]; } },
    prepare,
    commit: prepared => {
      for (const write of prepared as ReturnType<typeof prepare>) for (const [key, value] of Object.entries(write.fields)) {
        if ((write.types as Record<string, FieldType>)[key] === 'vec3') {
          const v = value as [number, number, number];
          (fieldsOf(write.owner)[key] as Vector3).set(v[0], v[1], v[2]);
        } else fieldsOf(write.owner)[key] = value;
      }
    },
    // Existing signal subscriptions survive; geometry is unused until transport ticks again.
  };
}
