// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive } from '../../core/engine/rv-drive';
import { captureSlotFeedback, restoreSlotFeedback, captureInputReplay, restoreInputReplay } from './rv-des-drive-feedback';
import type { Snapshottable } from './rv-snapshot-registry';
import { fromSnapshotData, type SnapshotSchema } from './rv-snapshot-contract';
import { captureKeys, captureRunState, restoreKeys, restoreRunState, driveStateOwners,
  runStateDeclaration, behaviorSnapshotType, driveRunStateDeclaration, RUN_STATE_KEYS, type DriveRunState } from './rv-des-drive-state';

interface DriveRecord {
  id: string;
  kind: 'des' | 'takt';
  drive: DriveRunState;
  behaviors: { type: string; state: DriveRunState; feedback: Record<string, boolean | number>; inputReplay: Record<string, boolean> }[];
}

const nullable = new Set(['directPosition', 'holdPosition', '_pendingTarget']);
// NaN marks an absent command/smooth target. Unbounded speed is legal; poses,
// feedback, acceleration and all behavior numbers must remain finite.
const nanSentinels = new Set(['commandedPosition', '_smoothPlanTarget', '_smoothEffectiveTarget']);
const unbounded = new Set(['TargetSpeed', 'targetSpeed']);

function checkState(value: DriveRunState, owner: object, keys: readonly string[], drive: boolean): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)))
    throw new Error('invalid run-state keys');
  const current = captureKeys(owner, keys);
  for (const key of keys) {
    const v = value[key];
    const numeric = typeof current[key] === 'number' || nullable.has(key);
    if (nullable.has(key) && v === null) continue;
    if (!Object.hasOwn(value, key) || (numeric ? typeof v !== 'number' : typeof v !== 'boolean')
      || typeof v === 'number' && !Number.isFinite(v)
        && !(drive && (nanSentinels.has(key) && Number.isNaN(v) || unbounded.has(key) && !Number.isNaN(v))))
      throw new Error(`invalid run-state field '${key}'`);
  }
}

/** Aggregated motion and signal-adapter owners, with no commands during apply. */
export function driveParticipant(des: ReadonlyMap<string, RVDrive>, takt: ReadonlyMap<string, RVDrive> = new Map())
  : Snapshottable & { apply(): void } {
  const entries: { id: string; drive: RVDrive; kind: 'des' | 'takt' }[] = [
    ...[...des].map(([id, drive]) => ({ id, drive, kind: 'des' as const })),
    ...[...takt].map(([id, drive]) => ({ id, drive, kind: 'takt' as const })),
  ];
  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const seen = new Set<RVDrive>();
  const byId = new Map(entries.map(e => [e.id, e]));
  for (const entry of entries) {
    if (seen.has(entry.drive) || des.has(entry.id) && takt.has(entry.id))
      throw new Error('des-snapshot-contract: duplicate drive ' + entry.id);
    seen.add(entry.drive);
  }
  const codecs: Record<string, 'number-tags'> = {};
  for (const e of entries) {
    for (const [key, v] of Object.entries(captureKeys(e.drive, RUN_STATE_KEYS)))
      if (typeof v === 'number') codecs[`[].drive.${key}`] = 'number-tags';
    for (const b of driveStateOwners(e.drive)) {
      for (const [key, v] of Object.entries(captureKeys(b, runStateDeclaration(b).stateKeys)))
        if (typeof v === 'number' || nullable.has(key)) codecs[`[].behaviors[].state.${key}`] = 'number-tags';
      for (const key of Object.keys(captureSlotFeedback(b))) codecs[`[].behaviors[].feedback.${key}`] = 'number-tags';
    }
  }
  const schema: SnapshotSchema = { codecs };
  const decode = (raw: unknown): DriveRecord[] => {
    const list = fromSnapshotData(raw, { participant: 'des.drives', ...schema }) as DriveRecord[];
    if (!Array.isArray(list) || list.length !== entries.length || new Set(list.map(d => d?.id)).size !== list.length)
      throw new Error('incomplete drives');
    for (const d of list) {
      const entry = byId.get(d?.id);
      if (!entry) throw new Error(`unknown drive '${d?.id}'`);
      if (Object.keys(d).sort().join() !== 'behaviors,drive,id,kind' || d.kind !== entry.kind)
        throw new Error(`invalid drive kind/record '${d.id}'`);
      checkState(d.drive, entry.drive, RUN_STATE_KEYS, true);
      const owners = driveStateOwners(entry.drive);
      if (!Array.isArray(d.behaviors) || d.behaviors.length !== owners.length) throw new Error('invalid behavior count');
      d.behaviors.forEach((b, i) => {
        if (!b || Object.keys(b).sort().join() !== 'feedback,inputReplay,state,type' || b.type !== behaviorSnapshotType(owners[i]))
          throw new Error(`drive behavior type mismatch '${d.id}#${i}'`);
        checkState(b.state, owners[i], runStateDeclaration(owners[i]).stateKeys, false);
        const fields = Object.keys(captureSlotFeedback(owners[i]));
        if (!b.feedback || typeof b.feedback !== 'object' || Array.isArray(b.feedback)
          || Object.keys(b.feedback).length !== fields.length || fields.some(key => !Object.hasOwn(b.feedback, key))
          || Object.values(b.feedback).some(v => typeof v !== 'boolean' && (typeof v !== 'number' || !Number.isFinite(v))))
          throw new Error(`invalid drive feedback '${d.id}#${i}'`);
        const inputs = Object.keys(captureInputReplay(owners[i]));
        if (!b.inputReplay || typeof b.inputReplay !== 'object' || Array.isArray(b.inputReplay)
          || Object.keys(b.inputReplay).length !== inputs.length || inputs.some(key => !Object.hasOwn(b.inputReplay, key))
          || Object.values(b.inputReplay).some(v => typeof v !== 'boolean'))
          throw new Error(`invalid drive input replay '${d.id}#${i}'`);
      });
    }
    return list;
  };
  let staged: DriveRecord[] = [];
  return {
    key: 'des.drives', version: 2, schema,
    owners: () => entries.flatMap(e => [
      { path: e.id, owner: e.drive as object, stateKeys: RUN_STATE_KEYS, services: driveRunStateDeclaration(e.drive).services },
      ...driveStateOwners(e.drive).map((b, i) => ({ path: `${e.id}#${i}:${behaviorSnapshotType(b)}`, owner: b,
        stateKeys: runStateDeclaration(b).stateKeys, services: runStateDeclaration(b).services })),
    ]),
    capture: () => entries.map(e => ({ id: e.id, kind: e.kind, drive: captureRunState(e.drive),
      behaviors: driveStateOwners(e.drive).map(b => ({ type: behaviorSnapshotType(b)!, state: captureKeys(b, runStateDeclaration(b).stateKeys),
        feedback: captureSlotFeedback(b), inputReplay: captureInputReplay(b) })) })),
    validate(raw) { try { decode(raw); return []; } catch (error) { return [String(error)]; } },
    prepare: decode,
    commit(value) { staged = value as DriveRecord[]; },
    apply() {
      for (const d of staged) restoreRunState(byId.get(d.id)!.drive, d.drive);
      for (const d of staged) {
        const drive = byId.get(d.id)!.drive;
        driveStateOwners(drive).forEach((b, i) => restoreKeys(b, runStateDeclaration(b).stateKeys, d.behaviors[i].state));
        driveStateOwners(drive).forEach((b, i) => restoreSlotFeedback(b, d.behaviors[i].feedback));
        driveStateOwners(drive).forEach((b, i) => restoreInputReplay(b, d.behaviors[i].inputReplay));
        drive.applyToNode();
      }
    },
  };
}
