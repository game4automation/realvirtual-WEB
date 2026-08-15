// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-binding-slot-resolver.ts — resolves the bindable standard-signal slots of a
 * placed Planner element to concrete SignalStore NAMES + the component instance
 * carrying the `liveControlled` gate.
 *
 * Walks the placed-element subtree, finds the relevant component types, and for
 * each declared slot (see slot-descriptors.ts) produces a {@link ResolvedSlot}
 * with the instance-scoped store name to relay into and the value type. All
 * targets are resolved to a NAME (not a path) so the binding manager can batch
 * via `signalStore.setMany`.
 *
 * Resolution per type:
 *  - Drive_Simple   → Forward/Backward = the resolved signal address the drive
 *                     subscribes to (skipped when not wired). instance = RVDriveSimple.
 *  - Drive_Cylinder → Out/In = the cylinder's Out/In signal address. instance = RVDriveCylinder.
 *  - Sensor         → IsOccupied = scopeSignalName(scope, <SensorNodeName>). instance = RVSensor.
 *  - Conveyor       → Flow.* = scopeSignalName(scope, 'Flow.<key>'). instance = null
 *                     (behavior gates via the live-control registry by name).
 */

import type { Object3D } from 'three';
import type { SignalStore } from './rv-signal-store';
import type { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { instanceScope, scopeSignalName } from './rv-instance-scope';
import type { SignalLinkDirection } from '../../plugins/layout-planner/rv-layout-store';
import { SLOT_DESCRIPTORS } from '../../plugins/signal-bind/slot-descriptors';
import { slotLabelOverride } from '../../plugins/signal-bind/slot-display-label';
import {
  getRegisteredSchemaTypes,
  getSchemaRegistrationEpoch,
  getSignalSlotFields,
} from './rv-component-registry';
// Side-effect import (plan-325): the generic slot iteration reads REGISTERED
// schemas — keep the standard Drive_* behaviors and the Sensor registering
// here (as the former DRIVE_BEHAVIOR_MAP / RVSensor imports implicitly did),
// so embedding contexts that import only the resolver still resolve them.
// SIGNAL_TYPES / isDuplicateSignalName additionally feed the raw PLC-signal
// slot branch (plan-418).
import { SIGNAL_TYPES, isDuplicateSignalName } from './rv-signal-construction';
import './rv-sensor';

/**
 * Behavior types whose slots are synthetic (descriptor-driven, no schema
 * `componentRef + signal` fields) — they still make a node slot-owning.
 */
const SYNTHETIC_SLOT_KEYS = new Set(['Conveyor', 'ConveyorBehavior']);

/** Fast membership test for the six raw PLC signal component keys (plan-418). */
const SIGNAL_TYPE_SET = new Set<string>(SIGNAL_TYPES);

/**
 * rv_extras component keys understood by {@link resolveElementSlots} and used
 * by DISCOVERY consumers (badge scan, compatible-targets) as a cheap pre-check.
 *
 * DERIVED, not hand-maintained (plan-418 Nachtrag). Since plan-325 the resolver
 * itself whitelists nothing — {@link resolveBindableSlots} iterates ALL
 * registered schema types with `componentRef + signal` fields generically.
 * Discovery, however, kept a hand-written list of the same types, and the two
 * drifted the moment a new slot-carrying component was added: `PushButton3D`,
 * `HandleSwitch3D`, `EmergencyButton3D` and `Lamp` all declare signal slots the
 * resolver happily resolves, yet they got no link-mode badge and no drop target
 * because nobody remembered to append them here ("why don't we have connector
 * icons for buttons and lamps?"). Deriving the list from the schema registry
 * removes that whole error class: a new component type is discoverable the
 * moment its schema declares a signal slot.
 *
 * Three sources, unioned:
 *  - {@link SYNTHETIC_SLOT_KEYS} — Conveyor/ConveyorBehavior have NO schema
 *    signal fields; their `Flow.*` slots are descriptor-driven, and
 *    ConveyorBehavior is an accepted legacy alias with no descriptor entry at
 *    all, so neither can be derived and both stay explicit.
 *  - `SIGNAL_TYPES` (plan-418) — a raw `PLCInput*`/`PLCOutput*` node IS a bind
 *    target in its own right (the node is the signal), so discovery has to
 *    consider it a candidate even though it has no slot-bearing schema.
 *  - every registered schema type with `getSignalSlotFields(type).length > 0`.
 *
 * NOT computed at module-load time: component schemas register as an import
 * side effect, so freezing the union here would capture only whatever modules
 * happened to load before this one. It is computed on first access and
 * recomputed whenever the schema-registration epoch moves.
 */
let _rvKeysEpoch = -1;
let _rvKeysCache: readonly string[] = [];
let _rvKeySetCache: ReadonlySet<string> = new Set<string>();

function ensureBindingSlotRvKeys(): void {
  const epoch = getSchemaRegistrationEpoch();
  if (epoch === _rvKeysEpoch) return;
  const keys = new Set<string>([...SYNTHETIC_SLOT_KEYS, ...SIGNAL_TYPES]);
  for (const type of getRegisteredSchemaTypes()) {
    if (getSignalSlotFields(type).length > 0) keys.add(type);
  }
  _rvKeySetCache = keys;
  _rvKeysCache = Object.freeze([...keys]);
  _rvKeysEpoch = epoch;
}

/**
 * The derived discovery key list (see above). A function, not a `const`:
 * the value depends on which component modules have registered so far, and an
 * eagerly evaluated constant would be silently short by exactly the types that
 * register after this module.
 */
export function bindingSlotRvKeys(): readonly string[] {
  ensureBindingSlotRvKeys();
  return _rvKeysCache;
}

/**
 * Cheap structural pre-check for DISCOVERY consumers: does the node declare any
 * rv_extras key the resolver knows how to turn into slots?
 *
 * Single owner (plan-418): `bindable-targets.ts` and `compatible-targets.ts`
 * each carried a byte-identical private copy of this loop, and the key list
 * they scan lives here — two copies of one rule over one list is exactly the
 * drift the consolidation removes.
 *
 * Iterates the NODE's keys against the derived set (a node carries a handful of
 * components, the derived set grows with the component library).
 */
export function hasResolverComponent(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  ensureBindingSlotRvKeys();
  for (const key of Object.keys(rv)) {
    if (rv[key] !== undefined && _rvKeySetCache.has(key)) return true;
  }
  return false;
}

/**
 * How far down the subtree a slot resolution reaches.
 *
 * - `'aggregate'` — the whole subtree belongs to `root`. Correct for Planner
 *   placements: the placement is offered as ONE bind target, so its inner
 *   component nodes are never separate targets and their slots must surface on
 *   the placement.
 * - `'own'` — the walk stops at descendants that carry bindable components of
 *   their own, because `findSignalBindTarget` offers each of those as its OWN
 *   bind target. Without this, nested chains (a robot's `A1/A2/.../A6`, where
 *   every axis carries a drive) make every ancestor repeat the slots of every
 *   axis below it — the A1 badge would list all six axes, A5 would list A5+A6.
 */
export type SlotScope = 'aggregate' | 'own';

export interface ResolvedSlot {
  /** Generic slot name (e.g. 'Forward', 'Flow.Run', 'IsOccupied'). */
  slot: string;
  /**
   * Human-readable name for the UI (plan-341 Phase 4). `slot` above stays the
   * identity; this is only what a row prints. Resolved via `slotLabelOverride()`.
   */
  label?: string;
  /** Instance-scoped SignalStore NAME this slot lives under. */
  targetName: string;
  type: 'bool' | 'float' | 'int';
  direction: SignalLinkDirection;
  aliases: string[];
  /** Component instance carrying a `liveControlled` flag (null for behaviors). */
  instance: { liveControlled?: boolean } | null;
  /** Underlying drive stopped during an atomic live-control handover. */
  drive?: RVDrive | null;
  /** Rising-edge slots do not receive bind-time seed/redispatch events. */
  edgeTriggered?: boolean;
  /** Descriptor roles are authoritative only for synthetic Sensor/Conveyor slots. */
  descriptorRoleFallback?: boolean;
}

interface BindableSlotBase {
  slot: string;
  /**
   * Human-readable name for the UI (plan-341 Phase 4) — carried alongside the
   * identity `slot` all the way into `SlotRow`. Undefined = show the raw name.
   */
  label?: string;
  type: 'bool' | 'float' | 'int';
  direction: SignalLinkDirection;
  aliases: string[];
  componentPath: string;
  /**
   * rv_extras component key of the ACTIVE registry instance that owns this
   * slot (plan-317 §2.4: exactly one active instance per node). Folded into
   * the canonical SlotId (plan-320 Phase 1) — never persisted. Optional so
   * hand-built slot fixtures stay valid; the binding manager falls back to ''
   * (defined, non-throwing) when absent.
   */
  componentType?: string;
  instance: { liveControlled?: boolean } | null;
  drive?: RVDrive | null;
  edgeTriggered?: boolean;
}

export interface MappedSignalSlot extends BindableSlotBase {
  kind: 'mapped-signal';
  targetName: string;
  descriptorRoleFallback?: boolean;
}

export interface DirectPropertySlot extends BindableSlotBase {
  kind: 'direct-property';
  command: (value: boolean | number) => void;
  neutralize: () => void;
}

export interface FeedbackSource {
  addFeedbackListener(cb: () => void): void;
  removeFeedbackListener(cb: () => void): void;
  readFeedbackSlot(slot: string): boolean | number;
}

export interface DirectFeedbackSlot extends BindableSlotBase {
  kind: 'direct-feedback';
  source: FeedbackSource;
}

export interface UnavailableSlot {
  kind: 'unavailable';
  slot: string;
  /** Display name (plan-341 Phase 4) — unavailable rows print it too. */
  label?: string;
  reason: string;
}

export type ActiveBindableSlot = MappedSignalSlot | DirectPropertySlot | DirectFeedbackSlot;
export type BindableSlot = ActiveBindableSlot | UnavailableSlot;

export interface BindEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Whether a Planner element declares a synthetic Sensor/Conveyor contract whose
 * signals may be materialised just after the badge controller starts. This is
 * only a discovery hint; actual bind rows still require registered store names.
 */
export function hasSyntheticBindableSlots(root: Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if (found) return;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    found = !!(rv && (rv.Sensor || rv.ConveyorBehavior || rv.Conveyor));
  });
  return found;
}

function pathInside(rootPath: string, candidatePath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

/**
 * Instance-level exclusion for writers that cannot participate in the v1 gate.
 * The checks use only registry-backed evidence and therefore fail closed without
 * inventing a drive-writer registry.
 */
export function getBindEligibility(root: Object3D, registry: NodeRegistry): BindEligibility {
  const rootPath = registry.getPathForNode(root) ?? NodeRegistry.computeNodePath(root);

  const erratic = registry.getAll('Drive_ErraticPosition')
    .find((entry) => pathInside(rootPath, entry.path));
  if (erratic) return { eligible: false, reason: 'controlled by Drive_ErraticPosition' };

  const candidateDrives = new Set(
    registry.getAll<object>('Drive')
      .filter((entry) => pathInside(rootPath, entry.path))
      .map((entry) => entry.instance),
  );
  if (candidateDrives.size > 0) {
    for (const robot of registry.getAll<{ getAxisDrives?: () => object[] }>('RobotIK')) {
      const axes = robot.instance.getAxisDrives?.() ?? [];
      if (axes.some((drive) => candidateDrives.has(drive))) {
        return { eligible: false, reason: 'controlled by an IK path' };
      }
    }
  }

  return { eligible: true };
}

/** Minimal shape of the drive-jog components we read addresses off of. */
interface DriveSimpleLike { Forward: string | null; Backward: string | null; liveControlled?: boolean }
interface DriveCylinderLike { Out: string | null; In: string | null; liveControlled?: boolean }
/** Minimal shape of Drive_DestinationMotor — its 8 slots hold resolved signal addresses. */
interface DriveDestinationMotorLike {
  Destination: string | null; StartDrive: string | null;
  TargetSpeed: string | null; Acceleration: string | null;
  IsAtPosition: string | null; IsAtSpeed: string | null;
  IsAtDestination: string | null; IsDriving: string | null;
  liveControlled?: boolean;
}

/** Resolve a signal ADDRESS (path or name) to a registered store NAME, or null. */
function addrToName(store: SignalStore, addr: string | null): string | null {
  if (!addr) return null;
  if (store.get(addr) !== undefined) return addr;       // already a name
  const byPath = store.nameForPath(addr);
  return byPath ?? null;
}

/** Identity of the ONE synthetic slot a raw PLC signal node offers. */
export const PLC_SIGNAL_SLOT = 'Value';

/**
 * The single bindable slot of a raw `PLCInput*`/`PLCOutput*` node, or the
 * canonical `unavailable` shape stating why it cannot be offered (plan-418).
 *
 * The node IS the signal: no `SLOT_DESCRIPTORS` entry, no component instance —
 * value type and direction come straight from the signal type, the store name
 * from the NodeRegistry entry `registerSignal()` wrote.
 *
 * Fail-closed cases, both deliberate:
 *  - `signal-not-registered` — extras declare a signal the loader never
 *    registered (old GLBs); binding it would write into nothing.
 *  - `duplicate-signal-name` — the name is shared with another node, and every
 *    layer below binds BY NAME, so binding one would drive the other too.
 *    Both partners report it (see `isDuplicateSignalName`).
 */
function plcSignalSlot(
  componentType: string,
  path: string,
  componentPath: string,
  store: SignalStore,
  registry: NodeRegistry,
): MappedSignalSlot | UnavailableSlot {
  const unavailable = (reason: string): UnavailableSlot =>
    ({ kind: 'unavailable', slot: PLC_SIGNAL_SLOT, reason });

  const entry = registry.getByPath<{ signalName?: string }>(componentType, path);
  const targetName = entry?.signalName;
  if (!targetName || store.get(targetName) === undefined) return unavailable('signal-not-registered');
  if (isDuplicateSignalName(store, targetName)) return unavailable('duplicate-signal-name');

  return {
    kind: 'mapped-signal',
    slot: PLC_SIGNAL_SLOT,
    targetName,
    type: signalPrimitive(componentType),
    // PLC convention, same rule as the generic schema branch:
    // PLCOutput = the PLC writes it (control), PLCInput = the viewer writes it.
    direction: componentType.startsWith('PLCOutput') ? 'plcOutput' : 'plcInput',
    aliases: [],
    componentPath,
    // The REAL type — deliberately not routed through resolveElementSlots(),
    // whose fallback lane stamps every row `componentType: 'Conveyor'`.
    componentType,
    // A signal node has no component carrying a `liveControlled` flag and no
    // drive to stop on handover; the name-keyed live-control gate does the work.
    instance: null,
    drive: null,
    edgeTriggered: false,
  };
}

/**
 * Does this node carry bindable components of its OWN (i.e. would it be offered
 * as a bind target in its own right)? Used as the `'own'`-scope subtree
 * boundary — see {@link SlotScope}.
 *
 * Structural + instance check: a declared component with no active registry
 * instance produces no slots, so it must not cut off its subtree.
 */
export function ownsBindableSlots(node: Object3D, registry: NodeRegistry): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  const path = registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
  for (const componentType of Object.keys(rv)) {
    const value = rv[componentType];
    if (!value || typeof value !== 'object') continue;
    if (SYNTHETIC_SLOT_KEYS.has(componentType)) return true;
    // plan-418: a raw PLC signal node is its OWN bind target — a registered
    // signal there ends the `'own'` walk exactly like a nested drive axis, so
    // an ancestor never repeats it. Same structural+instance rule as below:
    // extras without a registry entry produce no slot and must not cut off.
    if (SIGNAL_TYPE_SET.has(componentType)) {
      if (registry.getByPath(componentType, path)) return true;
      continue;
    }
    if (getSignalSlotFields(componentType).length === 0) continue;
    if (registry.getByPath(componentType, path)) return true;
  }
  return false;
}

/**
 * Subtree walk honouring {@link SlotScope}. `root` is ALWAYS visited — the
 * boundary only applies to descendants, so a slot-owning root still reports
 * its own slots.
 */
function traverseScoped(
  root: Object3D,
  registry: NodeRegistry,
  scope: SlotScope,
  visit: (node: Object3D) => void,
): void {
  if (scope === 'aggregate') {
    root.traverse(visit);
    return;
  }
  const walk = (node: Object3D): void => {
    visit(node);
    for (const child of node.children) {
      if (ownsBindableSlots(child, registry)) continue; // its own bind target
      walk(child);
    }
  };
  walk(root);
}

/**
 * Resolve every bindable slot offered by the placed element rooted at `root`.
 * De-duplicated by store name so two component types pointing at the same
 * signal don't create duplicate rows.
 */
export function resolveElementSlots(
  root: Object3D,
  store: SignalStore,
  registry: NodeRegistry,
  scope: SlotScope = 'aggregate',
): ResolvedSlot[] {
  const out: ResolvedSlot[] = [];
  const seen = new Set<string>();
  const add = (s: ResolvedSlot): void => {
    if (!s.targetName || seen.has(s.targetName)) return;
    seen.add(s.targetName);
    out.push(s);
  };

  traverseScoped(root, registry, scope, (node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    const path = NodeRegistry.computeNodePath(node);
    const nodeScope = instanceScope(node);

    // Drive_Simple
    if (rv['Drive_Simple']) {
      const inst = registry.getByPath<DriveSimpleLike>('Drive_Simple', path);
      const fwd = addrToName(store, inst?.Forward ?? null);
      const bwd = addrToName(store, inst?.Backward ?? null);
      const d = SLOT_DESCRIPTORS.Drive_Simple;
      const drive = registry.getByPath<RVDrive>('Drive', path);
      if (fwd) add({ ...d[0], label: slotLabelOverride('Drive_Simple', d[0].slot), targetName: fwd, aliases: d[0].aliases ?? [], instance: inst ?? null, drive, edgeTriggered: false });
      if (bwd) add({ ...d[1], label: slotLabelOverride('Drive_Simple', d[1].slot), targetName: bwd, aliases: d[1].aliases ?? [], instance: inst ?? null, drive, edgeTriggered: false });
    }

    // Drive_Cylinder
    if (rv['Drive_Cylinder']) {
      const inst = registry.getByPath<DriveCylinderLike>('Drive_Cylinder', path);
      const out0 = addrToName(store, inst?.Out ?? null);
      const in0 = addrToName(store, inst?.In ?? null);
      const d = SLOT_DESCRIPTORS.Drive_Cylinder;
      const drive = registry.getByPath<RVDrive>('Drive', path);
      if (out0) add({ ...d[0], label: slotLabelOverride('Drive_Cylinder', d[0].slot), targetName: out0, aliases: d[0].aliases ?? [], instance: inst ?? null, drive, edgeTriggered: false });
      if (in0) add({ ...d[1], label: slotLabelOverride('Drive_Cylinder', d[1].slot), targetName: in0, aliases: d[1].aliases ?? [], instance: inst ?? null, drive, edgeTriggered: false });
    }

    // Drive_DestinationMotor — its 8 standard slots hold resolved signal
    // addresses (auto-provisioned or GLB). instance = the motor (carries the
    // liveControlled gate set by the binding manager).
    if (rv['Drive_DestinationMotor']) {
      const inst = registry.getByPath<DriveDestinationMotorLike>('Drive_DestinationMotor', path);
      const drive = registry.getByPath<RVDrive>('Drive', path);
      const descs = SLOT_DESCRIPTORS.Drive_DestinationMotor;
      for (const d of descs) {
        const addr = (inst?.[d.slot as keyof DriveDestinationMotorLike] as string | null | undefined) ?? null;
        const name = addrToName(store, addr);
        if (name) add({
          ...d,
          label: slotLabelOverride('Drive_DestinationMotor', d.slot),
          targetName: name,
          aliases: d.aliases ?? [],
          instance: inst ?? null,
          drive,
          edgeTriggered: d.slot === 'StartDrive',
        });
      }
    }

    // Conveyor behavior — Flow.* under the type-neutral namespace.
    if (rv['ConveyorBehavior'] || rv['Conveyor']) {
      for (const d of SLOT_DESCRIPTORS.Conveyor) {
        const scoped = scopeSignalName(nodeScope, d.slot);
        if (store.get(scoped) !== undefined) {
          add({
            ...d,
            label: slotLabelOverride('Conveyor', d.slot),
            targetName: scoped,
            aliases: d.aliases ?? [],
            instance: null,
            drive: null,
            edgeTriggered: false,
            descriptorRoleFallback: true,
          });
        }
      }
    }
  });

  return out;
}

function relativeComponentPath(root: Object3D, node: Object3D, registry: NodeRegistry): string {
  const rootPath = registry.getPathForNode(root) ?? NodeRegistry.computeNodePath(root);
  const nodePath = registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
  if (nodePath === rootPath) return '.';
  if (rootPath && nodePath.startsWith(`${rootPath}/`)) return nodePath.slice(rootPath.length + 1);
  return nodePath || '.';
}

function signalPrimitive(signal: string): 'bool' | 'float' | 'int' {
  if (signal.includes('Bool')) return 'bool';
  if (signal.includes('Int')) return 'int';
  return 'float';
}

function aliasesFor(componentType: string, slot: string): string[] {
  return SLOT_DESCRIPTORS[componentType]?.find((descriptor) => descriptor.slot === slot)?.aliases ?? [];
}

function legacyComponentPath(
  root: Object3D,
  slot: ResolvedSlot,
  registry: NodeRegistry,
): string {
  let match: Object3D | null = null;
  root.traverse((node) => {
    if (match) return;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    const path = registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
    if (rv.Sensor && registry.getByPath('Sensor', path) === slot.instance) match = node;
    if ((rv.Conveyor || rv.ConveyorBehavior)
      && scopeSignalName(instanceScope(node), slot.slot) === slot.targetName) match = node;
  });
  return relativeComponentPath(root, match ?? root, registry);
}

/** Dev-only resolver-runtime warn threshold in ms (plan-325 Phase 1 Messpunkt). */
const RESOLVER_RUNTIME_WARN_MS = 10;

/**
 * Resolve the mapped/direct union. The selection switch is evaluated per
 * component instance: any GLB-authored signal keeps that instance mapped-only;
 * a fully auto-provisioned v1 drive exposes direct command slots instead.
 *
 * Slot discovery is GENERIC (plan-325 Phase 1): every rv_extras component type
 * with a registered schema declaring `componentRef + signal` fields yields
 * slots — the discovery key list ({@link bindingSlotRvKeys}) is derived from
 * exactly the same schema rule, so the two can no longer drift apart.
 * `SLOT_DESCRIPTORS` stays the alias-/synthetic fallback (Conveyor `Flow.*`).
 */
export function resolveBindableSlots(
  root: Object3D,
  store: SignalStore,
  registry: NodeRegistry,
  scope: SlotScope = 'aggregate',
): BindableSlot[] {
  const t0 = import.meta.env.DEV && typeof performance !== 'undefined' ? performance.now() : 0;
  const output: BindableSlot[] = [];
  const mappedTargets = new Set<string>();
  const directKeys = new Set<string>();

  traverseScoped(root, registry, scope, (node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    const path = registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
    const componentPath = relativeComponentPath(root, node, registry);
    const drive = registry.getByPath<RVDrive>('Drive', path);
    // At most ONE synthetic PLC row per node: `Value` is the slot identity, so
    // a node declaring two signal-type keys must not emit it twice.
    let plcSlotEmitted = false;

    for (const componentType of Object.keys(rv)) {
      const value = rv[componentType];
      if (!value || typeof value !== 'object') continue;

      // Raw PLC signal node (plan-418): ONE synthetic slot, resolved here and
      // NOT via resolveElementSlots() — that lane only forwards rows carrying
      // `descriptorRoleFallback` and relabels them `componentType: 'Conveyor'`
      // (see the fallback loop at the end of this function), so a PLC slot
      // would never arrive intact.
      if (SIGNAL_TYPE_SET.has(componentType)) {
        if (plcSlotEmitted) continue;
        const plcSlot = plcSignalSlot(componentType, path, componentPath, store, registry);
        if (plcSlot.kind === 'mapped-signal') {
          // A drive's auto-provisioned signal node sits UNDER the drive: in
          // 'aggregate' scope the drive's own row for the same store name was
          // already emitted (parent before child) and wins — no duplicate row.
          if (mappedTargets.has(plcSlot.targetName)) continue;
          mappedTargets.add(plcSlot.targetName);
        }
        plcSlotEmitted = true;
        output.push(plcSlot);
        continue;
      }

      // Generic schema introspection: only types whose registered schema
      // declares componentRef+signal fields participate (cached per type).
      const signalFields = getSignalSlotFields(componentType);
      if (signalFields.length === 0) continue;
      const instance = registry.getByPath<Record<string, unknown>>(componentType, path);
      if (!instance) continue;

      for (const { field: slot, signal } of signalFields) {
        // plan-341 Phase 4: the display name of a generically discovered schema
        // slot — this is the path `Drive_Simple.Accelaration` travels.
        const label = slotLabelOverride(componentType, slot);
        const targetName = addrToName(store, (instance[slot] as string | null | undefined) ?? null);
        if (targetName) {
          if (mappedTargets.has(targetName)) continue;
          mappedTargets.add(targetName);
          output.push({
            kind: 'mapped-signal',
            slot,
            label,
            targetName,
            type: signalPrimitive(signal),
            direction: signal.startsWith('PLCOutput') ? 'plcOutput' : 'plcInput',
            aliases: aliasesFor(componentType, slot),
            componentPath,
            componentType,
            instance,
            drive,
            edgeTriggered: slot === 'StartDrive',
          });
          continue;
        }

        const key = `${componentPath}\u0000${slot}`;
        if (directKeys.has(key)) continue;
        directKeys.add(key);

        if (signal.startsWith('PLCOutput')) {
          const command = instance[`command${slot}`];
          const neutralize = instance[`neutralize${slot}`];
          if (typeof command === 'function' && typeof neutralize === 'function') {
            output.push({
              kind: 'direct-property',
              slot,
              label,
              type: signalPrimitive(signal),
              direction: 'plcOutput',
              aliases: aliasesFor(componentType, slot),
              componentPath,
              componentType,
              instance,
              drive,
              edgeTriggered: slot === 'StartDrive',
              command: (value) => command.call(instance, value),
              neutralize: () => neutralize.call(instance),
            });
          } else {
            output.push({ kind: 'unavailable', slot, label, reason: `Missing command contract for ${componentType}.${slot}` });
          }
          continue;
        }

        const source = instance as unknown as Partial<FeedbackSource>;
        if (typeof source.addFeedbackListener === 'function'
          && typeof source.removeFeedbackListener === 'function'
          && typeof source.readFeedbackSlot === 'function') {
          output.push({
            kind: 'direct-feedback',
            slot,
            label,
            type: signalPrimitive(signal),
            direction: 'plcInput',
            aliases: aliasesFor(componentType, slot),
            componentPath,
            componentType,
            instance,
            drive,
            edgeTriggered: false,
            source: source as FeedbackSource,
          });
        } else {
          output.push({ kind: 'unavailable', slot, label, reason: `Missing feedback contract for ${componentType}.${slot}` });
        }
      }
    }
  });

  for (const slot of resolveElementSlots(root, store, registry, scope)) {
    if (!slot.descriptorRoleFallback || mappedTargets.has(slot.targetName)) continue;
    mappedTargets.add(slot.targetName);
    output.push({
      ...slot,
      kind: 'mapped-signal',
      componentPath: legacyComponentPath(root, slot, registry),
      // Only the Conveyor branch of resolveElementSlots sets
      // descriptorRoleFallback — these synthetic behavior slots have no
      // registry instance, their component key is the behavior type itself.
      componentType: 'Conveyor',
    });
  }
  // Resolver-runtime measuring point (plan-325 Phase 1): the resolver runs only
  // on selection/model-load, but large assemblies × generic type iteration can
  // add up — surface outliers in dev builds.
  if (import.meta.env.DEV && t0 > 0) {
    const dt = performance.now() - t0;
    if (dt > RESOLVER_RUNTIME_WARN_MS) {
      console.debug(`[rv] resolveBindableSlots took ${dt.toFixed(1)} ms (${output.length} slots)`);
    }
  }
  return output;
}
