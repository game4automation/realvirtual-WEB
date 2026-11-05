// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { RVLogicEngine } from '../../core/engine/rv-logic-engine';
import {
  RVDelay, RVDriveTo, RVEnable, RVGripPick, RVGripPlace, RVJavaScriptStep, RVJumpOnSignal,
  RVParallelContainer, RVSerialContainer, RVSetDriveSpeed, RVSetSignalBool, RVSetSignalFloat,
  RVStartDriveTo, RVWaitForDrivesAtTarget, RVWaitForSensor, RVWaitForSignalBool,
  RVWaitForSignalFloat, RVWaitForZone, StepState, type RVLogicStep,
} from '../../core/engine/rv-logic-step';
import { RVIKPathStep } from '../../core/engine/rv-ik-path-step';
import type { Snapshottable, SnapshotJson, SnapshotSchema } from '../../core/sdk/rv-snapshot-contract-types';
import { fromSnapshotData } from './rv-snapshot-contract';
import { logicStepNodes, logicSteps } from './rv-des-logic-check';
import type { LogicEventParticipant } from './rv-des-logic';

type Fields = Record<string, unknown>;
type FieldType = 'number' | 'boolean' | 'state' | 'reason' | 'numbers' | 'nullable-number';
const baseState = { state: 'state', reason: 'reason' } as const;
const baseServices = ['name', 'hierarchyPath', 'rootContext'];

// Explicit tables keep new fields visible to the multi-owner completeness guard.
const tables = [
  [RVIKPathStep, { _ownsPath: 'boolean', _cancelled: 'boolean' }, ['ikPath']],
  [RVSerialContainer, { currentIndex: 'number', completedCycles: 'number', cycleStartTime: 'number', cycleTimes: 'numbers' }, ['children', 'autoLoop']],
  [RVParallelContainer, { finishedCount: 'number' }, ['children']],
  [RVDelay, { duration: 'number', elapsed: 'number', startT: 'number' }, []],
  [RVWaitForSignalBool, { _edgePrev: 'boolean', _edgeSeen: 'boolean' }, ['signalAddress', 'waitForTrue', 'edge', 'signalStore', '_edgeUnsub', '_onEdgeValue']],
  [RVDriveTo, { destination: 'number', startPosition: 'number', targetPosition: 'number' }, ['drive', 'relative', 'destinationSignal', 'valueBySignal', 'signalStore']],
  [RVStartDriveTo, { _commandedTarget: 'nullable-number' }, ['drive', 'destination', 'relative']],
  [RVSetSignalBool, { value: 'boolean' }, ['signalAddress', 'signalStore', 'signalWriter', 'targetName']],
  [RVJavaScriptStep, { runId: 'number' }, []],
  [RVEnable, {}, ['target', 'enable']],
  [RVSetSignalFloat, {}, ['signalAddress', 'value', 'signalStore', 'signalWriter', 'targetName']],
  [RVWaitForSignalFloat, {}, ['signalAddress', 'comparison', 'value', 'tolerance', 'signalStore']],
  [RVWaitForSensor, {}, ['sensor', 'waitForOccupied', 'waitForStopped']],
  [RVWaitForZone, {}, ['zone', 'waitForOccupied']],
  [RVWaitForDrivesAtTarget, {}, ['drives']],
  [RVSetDriveSpeed, {}, ['drive', 'speed']],
  [RVGripPick, {}, ['grip', 'blocking']],
  [RVGripPlace, {}, ['grip', 'blocking']],
  [RVJumpOnSignal, {}, ['signalAddress', 'jumpOn', 'jumpToStep', 'signalStore', 'parentContainer']],
] as const;

function contract(reason: string): never { throw new Error(`des-snapshot-contract: core.logic: ${reason}`); }

export function logicStepKeyTable(step: RVLogicStep) {
  const table = tables.find(([type]) => step instanceof type && Object.getPrototypeOf(step) === type.prototype);
  if (!table) contract(`unknown step class ${step.constructor.name}`);
  return { type: table[0].name, fields: { ...baseState, ...table[1] } as Record<string, FieldType>,
    stateKeys: [...Object.keys(baseState), ...Object.keys(table[1])], services: [...baseServices, ...table[2]] };
}

const coldDefaults = new WeakMap<RVLogicStep, Fields>();

/** Keep constructor-assigned configuration while clearing every declared runtime field. */
export function logicColdReset(engine: RVLogicEngine): () => void {
  const steps = engine.roots.flatMap(logicSteps);
  for (const step of steps) if (!coldDefaults.has(step)
    && tables.some(([type]) => Object.getPrototypeOf(step) === type.prototype)) {
    const defaults: Fields = {};
    for (const [key, type] of Object.entries(logicStepKeyTable(step).fields)) {
      // Runtime-edited configuration keeps its current value.
      if (['duration', 'destination', 'value'].includes(key)) continue;
      defaults[key] = type === 'state' ? StepState.Idle : type === 'reason' ? undefined
          : type === 'numbers' ? [] : type === 'boolean' ? false : type === 'nullable-number' ? null : 0;
    }
    coldDefaults.set(step, defaults);
  }
  return () => {
    // No cancel(): core owners (drives) were already reset; a late cancel would clobber them.
    engine.reset();
    for (const step of steps) for (const [key, value] of Object.entries(coldDefaults.get(step) ?? {}))
      (step as unknown as Fields)[key] = Array.isArray(value) ? [...value] : value;
    const state = engine as unknown as EngineState;
    state.connected = false;
    state.started = false;
    state.lastCommander.clear();
    // Suppression is set by the owner of the replacing program, not by the run.
    for (const runtime of state.runtimeByRoot.values()) { runtime.active = false; runtime.want = false; }
  };
}

/** Restore only the derived subscription, preserving the captured edge history. */
export function resubscribeEdge(step: RVWaitForSignalBool): void {
  const fields = step as unknown as {
    _dropEdgeSubscription(): void;
    _edgeUnsub: (() => void) | null;
    _onEdgeValue: Parameters<import('../../core/engine/rv-signal-store').SignalStore['subscribeByPath']>[1];
    edge: string;
    signalAddress: string | null;
    signalStore: import('../../core/engine/rv-signal-store').SignalStore;
  };
  fields._dropEdgeSubscription();
  if (step.state === StepState.Waiting && fields.edge !== 'Level' && fields.signalAddress)
    fields._edgeUnsub = fields.signalStore.subscribeByPath(fields.signalAddress, fields._onEdgeValue);
}

const runtimeFields = { active: 'boolean', want: 'boolean', suppressed: 'boolean' } as const;
const engineFields = { connected: 'boolean', started: 'boolean' } as const;
const engineServices = ['eventTime', 'eventImage', 'desHooks', 'roots', 'stepByPath', 'activeOnly',
  'warnings', 'runtimeByRoot', 'resetStore', 'resetWriter', 'rootNodeByStep', 'skippedMaintenancePaths'];
const runtimeServices = ['ownedOutputs', 'drives', 'motionWithoutCancel', 'root', 'activeOnly', 'engine'];
interface RootRuntime extends Fields { root: RVLogicStep; drives: RVDrive[] }
interface EngineState extends Fields { runtimeByRoot: Map<RVLogicStep, RootRuntime>; lastCommander: Map<RVDrive, RootRuntime> }
interface LogicState {
  engine: Fields;
  roots: { address: string; runtime: Fields }[];
  steps: { address: string; type: string; childCount: number; state: Fields; enabled?: boolean | null }[];
  lastCommander: [string, string][];
  run: { lastEval: number };
}
const schema: SnapshotSchema = { codecs: {
  'steps[].state.duration': 'number-tags', 'steps[].state.elapsed': 'number-tags',
  'steps[].state.startT': 'number-tags', 'steps[].state.currentIndex': 'number-tags',
  'steps[].state.completedCycles': 'number-tags', 'steps[].state.cycleStartTime': 'number-tags',
  'steps[].state.cycleTimes[]': 'number-tags', 'steps[].state.finishedCount': 'number-tags',
  'steps[].state.destination': 'number-tags', 'steps[].state.startPosition': 'number-tags',
  'steps[].state.targetPosition': 'number-tags', 'steps[].state._commandedTarget': 'number-tags',
  'steps[].state.runId': 'number-tags', 'run.lastEval': 'number-tags',
} };
const fieldsOf = (value: object): Fields => value as Fields;
const pick = (owner: object, keys: readonly string[]): Fields => Object.fromEntries(keys.map(key =>
  [key, key === 'reason' ? fieldsOf(owner)[key] ?? null : fieldsOf(owner)[key]]));
const object = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);
function keys(value: unknown, expected: readonly string[], path: string): asserts value is Fields {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
    contract(`${path}: key set mismatch`);
}
function checkFields(value: unknown, types: Record<string, FieldType>, path: string): asserts value is Fields {
  keys(value, Object.keys(types), path);
  for (const [key, type] of Object.entries(types)) {
    const v = value[key];
    const valid = type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : type === 'boolean' ? typeof v === 'boolean'
        : type === 'state' ? Object.values(StepState).includes(v as StepState)
          : type === 'reason' ? v === null || v === 'suppressed-live'
            : type === 'nullable-number' ? v === null || typeof v === 'number' && Number.isFinite(v)
              : Array.isArray(v) && v.every(n => typeof n === 'number' && Number.isFinite(n));
    if (!valid) contract(`${path}.${key}: invalid ${type}`);
  }
}

export function logicSnapshotParticipant(engine: RVLogicEngine, participant: LogicEventParticipant,
  addressOf: (node: Object3D) => string | null): Snapshottable {
  const state = engine as unknown as EngineState;
  const address = (node: Object3D | undefined): string => {
    const id = node && addressOf(node);
    if (!id) throw Object.assign(new Error('des-snapshot-unaddressable: core.logic step or drive'), { code: 'des-snapshot-unaddressable' });
    return id;
  };
  const stepAddress = (step: RVLogicStep) => address(logicStepNodes(engine).get(step));
  const compare = (a: { address: string }, b: { address: string }) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  // Resolve identities afresh for every capture/restore boundary, never from hierarchyPath.
  const inventory = () => {
    const steps = engine.roots.flatMap(logicSteps).map(step => ({ step, address: stepAddress(step), table: logicStepKeyTable(step) })).sort(compare);
    if (new Set(steps.map(s => s.address)).size !== steps.length) contract('duplicate step address');
    const roots = engine.roots.map(root => {
      const runtime = state.runtimeByRoot.get(root);
      if (!runtime) contract(`missing root runtime ${root.name}`);
      return { address: stepAddress(root), runtime };
    }).sort(compare);
    const drives = new Map<string, RVDrive>();
    for (const { runtime } of roots) for (const drive of runtime.drives) {
      const id = address(drive.node);
      if (drives.has(id) && drives.get(id) !== drive) contract(`duplicate drive address ${id}`);
      drives.set(id, drive);
    }
    return { steps, roots, drives };
  };
  const childCount = (step: RVLogicStep) => step instanceof RVSerialContainer || step instanceof RVParallelContainer ? step.children.length : 0;
  const prepare = (json: SnapshotJson) => {
    const dto = fromSnapshotData(json, { participant: 'core.logic', ...schema }) as unknown as LogicState;
    const live = inventory();
    keys(dto, ['engine', 'roots', 'steps', 'lastCommander', 'run'], '$');
    checkFields(dto.engine, engineFields, 'engine');
    checkFields(dto.run, { lastEval: 'number' }, 'run');
    if (!Array.isArray(dto.roots) || dto.roots.length !== live.roots.length
      || !Array.isArray(dto.steps) || dto.steps.length !== live.steps.length) contract('incomplete root/step set');
    const rootWrites = live.roots.map((root, i) => {
      const entry = dto.roots[i];
      keys(entry, ['address', 'runtime'], `roots[${i}]`);
      if (entry.address !== root.address) contract(`unknown or unordered root address ${entry.address}`);
      checkFields(entry.runtime, runtimeFields, `roots[${i}].runtime`);
      return { owner: root.runtime, fields: entry.runtime };
    });
    const stepWrites = live.steps.map(({ step, address, table }, i) => {
      const entry = dto.steps[i];
      keys(entry, ['address', 'type', 'childCount', 'state', ...(step instanceof RVEnable ? ['enabled'] : [])], `steps[${i}]`);
      if (entry.address !== address || entry.type !== table.type) contract(`step address/class mismatch at ${address}`);
      if (entry.childCount !== childCount(step)) contract(`container child count mismatch at ${address}`);
      checkFields(entry.state, table.fields, `steps[${i}].state`);
      if (step instanceof RVEnable && (step.target ? typeof entry.enabled !== 'boolean' : entry.enabled !== null))
        contract(`invalid enabled value at ${address}`);
      const n = entry.state;
      if (step instanceof RVSerialContainer && (!Number.isInteger(n.currentIndex) || (n.currentIndex as number) < -1
        || (n.currentIndex as number) > entry.childCount || !Number.isSafeInteger(n.completedCycles) || (n.completedCycles as number) < 0)
        || step instanceof RVParallelContainer && (!Number.isSafeInteger(n.finishedCount) || (n.finishedCount as number) < 0 || (n.finishedCount as number) > entry.childCount))
        contract(`invalid container counters at ${address}`);
      return { owner: step, fields: { ...n, reason: n.reason === null ? undefined : n.reason }, enabled: entry.enabled };
    });
    if (!Array.isArray(dto.lastCommander)) contract('invalid lastCommander');
    const commanders = new Map<RVDrive, RootRuntime>();
    for (const pair of dto.lastCommander) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(id => typeof id !== 'string')) contract('invalid lastCommander pair');
      const drive = live.drives.get(pair[0]);
      const root = live.roots.find(r => r.address === pair[1]);
      if (!drive || !root || !root.runtime.drives.includes(drive) || commanders.has(drive)) contract('unknown or duplicate lastCommander address');
      commanders.set(drive, root.runtime);
    }
    return { engine: dto.engine, run: dto.run, rootWrites, stepWrites, commanders };
  };
  return {
    key: 'core.logic', version: 1, dependencies: ['des.signals', 'des.drives'], schema,
    owners: () => {
      const live = inventory();
      return [
        { path: 'engine', owner: engine, stateKeys: [...Object.keys(engineFields), 'lastCommander'], services: engineServices },
        { path: 'run', owner: participant.run, stateKeys: ['lastEval'] },
        ...live.roots.map(r => ({ path: `${r.address}:runtime`, owner: r.runtime, stateKeys: Object.keys(runtimeFields), services: runtimeServices })),
        ...live.steps.map(s => ({ path: `${s.address}:${s.table.type}`, owner: s.step, stateKeys: s.table.stateKeys, services: s.table.services })),
      ];
    },
    capture: () => {
      const live = inventory();
      return {
        engine: pick(engine, Object.keys(engineFields)), run: { ...participant.run },
        roots: live.roots.map(r => ({ address: r.address, runtime: pick(r.runtime, Object.keys(runtimeFields)) })),
        steps: live.steps.map(s => ({ address: s.address, type: s.table.type, childCount: childCount(s.step),
          state: pick(s.step, s.table.stateKeys), ...(s.step instanceof RVEnable ? { enabled: s.step.target?.visible ?? null } : {}) })),
        lastCommander: [...state.lastCommander].map(([drive, rt]) => [address(drive.node), stepAddress(rt.root)])
          .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      };
    },
    validate: json => { try { prepare(json); return []; } catch (error) { return [String(error)]; } },
    prepare,
    commit: prepared => {
      const p = prepared as ReturnType<typeof prepare>;
      Object.assign(engine, p.engine);
      Object.assign(participant.run, p.run);
      for (const w of p.rootWrites) Object.assign(w.owner, w.fields);
      for (const w of p.stepWrites) {
        Object.assign(w.owner, w.fields);
        // Visibility is a pure field write and belongs inside the transaction.
        if (w.owner instanceof RVEnable && w.owner.target) w.owner.target.visible = w.enabled!;
      }
      state.lastCommander = p.commanders;
    },
    onRestore: () => {
      for (const { step } of inventory().steps) if (step instanceof RVWaitForSignalBool) resubscribeEdge(step);
      participant.reattachWakeListeners();
    },
  };
}
