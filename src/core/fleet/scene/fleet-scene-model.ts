// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * fleet-scene-model.ts — reads the fleet scene components into one typed
 * model (plan-559 Phase 3, `readFleetScene(root): FleetSceneModel`).
 *
 * Called by the fleet core LATE — after `placements-materialized` /
 * `whenSceneReady()` and again on `layout-content-added` — never during the
 * load traversal: station partners and fork anchors may live inside
 * placements that materialise asynchronously (559 M1).
 *
 * Reads the raw extras (`userData.realvirtual`), applies the schema defaults
 * from fleet-components.ts and resolves reference fields through the ONE
 * resolver (`NodeRegistry.resolve`, scope = the enclosing registered scope of
 * the component's node, the node as referrer). Pure read: no registration, no side effects,
 * so it can run again after every placement change.
 *
 * Ids are instance-unique registry paths (`NodeRegistry.computeNodePath`),
 * never base names (Lehre 612/622: names are unique per file only).
 * Determinism: every list is sorted by id.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from '../../engine/rv-component-registry';
import { isComponentReference } from '../../engine/rv-node-path-rewrite.mjs';
import { NodeRegistry, type ComponentRef } from '../../engine/rv-node-registry';
import { instanceScopeNode } from '../../engine/rv-instance-scope';
import type { BatteryConfig } from '../core/battery';
import {
  BATTERY_PROFILE_SCHEMA,
  BATTERY_PROFILE_TYPE,
  CHARGER_SCHEMA,
  CHARGER_TYPE,
  FLEET_SCHEMA,
  FLEET_TYPE,
  FORKLIFT_PROFILE_SCHEMA,
  FORKLIFT_PROFILE_TYPE,
  TRANSFER_STATION_SCHEMA,
  TRANSFER_STATION_TYPE,
  WAIT_POINT_SCHEMA,
  WAIT_POINT_TYPE,
} from './fleet-components';

// ─── Model types ─────────────────────────────────────────────────────

export type TransferRole = 'pick' | 'drop' | 'storage' | 'both';
export type PartnerType = 'Conveyor' | 'Floor';
export type PartnerEnd = 'tail' | 'head';
export type Approach = 'reverse' | 'forward';
export type WaitPrecedence = 'charge-queue-first' | 'arrival-order';

export interface DesignVehicle {
  readonly lengthMm: number;
  readonly widthMm: number;
}

export interface FleetSettings {
  readonly designVehicle: DesignVehicle | null;
  readonly designLoadOffsetMm: number;
  readonly id: string;
  readonly node: Object3D;
  readonly enabled: boolean;
  readonly vehicleSelection: string;
  readonly charging: string;
  /** Sim-s; 0 = never reported. */
  readonly waitLimitSec: number;
  readonly targetWaitLimitSec: number;
  readonly chargeWaitLimitSec: number;
  readonly standstillLimitSec: number;
}

export interface TransferStationModel {
  readonly dockPort: string;
  /** Registry path of the component's node — the `StationId` of the core. */
  readonly id: string;
  /** `StationName`, else the node name. */
  readonly name: string;
  readonly node: Object3D;
  readonly role: TransferRole;
  /** Stub path id (`PathId`, else the node's own Path); null = none found. */
  readonly pathId: string | null;
  readonly partnerType: PartnerType;
  /** The conveyor node: `Partner`, else (Conveyor) the station node; null for Floor. */
  readonly partner: Object3D | null;
  readonly partnerEnd: PartnerEnd;
  readonly handlingHeightMm: number;
  readonly approach: Approach;
  /** Empty string = no group. */
  readonly group: string;
  /** Floor seat pose; null = the stub end. */
  readonly seat: Object3D | null;
}

export interface ChargerModel {
  readonly id: string;
  readonly node: Object3D;
  readonly pathId: string | null;
  /** %-points per minute. */
  readonly chargeRatePerMin: number;
}

export interface WaitPointModel {
  readonly id: string;
  readonly node: Object3D;
  readonly pathId: string | null;
  readonly capacity: number;
  readonly precedence: WaitPrecedence;
}

export interface ForkliftProfileModel {
  readonly id: string;
  readonly node: Object3D;
  /** Node of the lift drive (resolved), null = unset / unresolved. */
  readonly lift: Object3D | null;
  readonly forkAnchor: Object3D | null;
  readonly liftRangeMm: number;
  readonly handlingDeltaMm: number;
  readonly liftSpeedEmptyMmS: number;
  readonly liftSpeedLoadedMmS: number;
  readonly travelHeightMm: number;
  readonly preLift: boolean;
  readonly lowerAfterExit: boolean;
}

export interface BatteryProfileModel {
  readonly id: string;
  readonly node: Object3D;
  readonly startSoc: number;
  readonly drivePerMin: number;
  readonly liftPerM: number;
  readonly idlePerMin: number;
  readonly threshold: number;
  readonly target: number;
  readonly reserveToCharger: number;
  readonly travelSlack: number;
  readonly chargerWaitReserveSec: number;
}

export interface FleetSceneIssue {
  readonly code: 'fleet-duplicate' | 'fleet-unresolved-reference' | 'fleet-missing-path' | 'fleet-invalid-value'
    | 'fleet-design-vehicle-incomplete' | 'fleet-load-offset-ambiguous' | 'fleet-load-offset-missing';
  readonly node: string;
  readonly message: string;
}

export interface FleetSceneModel {
  /** The first `Fleet` (by id); null = no fleet in the scene. */
  readonly fleet: FleetSettings | null;
  readonly stations: readonly TransferStationModel[];
  readonly chargers: readonly ChargerModel[];
  readonly waitPoints: readonly WaitPointModel[];
  readonly forkliftProfiles: readonly ForkliftProfileModel[];
  readonly batteryProfiles: readonly BatteryProfileModel[];
  readonly issues: readonly FleetSceneIssue[];
}

/** The lookup `readFleetScene` needs (`NodeRegistry` satisfies it). */
export type FleetReferenceResolver = Pick<NodeRegistry, 'resolve'>;

// ─── Field reading ───────────────────────────────────────────────────

type Raw = Record<string, unknown>;

/** Component configs of a node: the exact key and `_N` dedup keys. */
function configsOf(node: Object3D, type: string): Raw[] {
  const rv = node.userData?.realvirtual as Raw | undefined;
  if (!rv) return [];
  const out: Raw[] = [];
  for (const key in rv) {
    if (key !== type && !(key.startsWith(`${type}_`) && /^\d+$/.test(key.slice(type.length + 1)))) continue;
    const cfg = rv[key];
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) out.push(cfg as Raw);
  }
  return out;
}

function defaultOf<T>(schema: ComponentSchema, field: string): T {
  return schema[field]?.default as T;
}

function num(raw: Raw, schema: ComponentSchema, field: string): number {
  const v = raw[field];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return defaultOf<number>(schema, field);
  const d = schema[field];
  let out = n;
  if (d?.min !== undefined && out < d.min) out = d.min;
  if (d?.max !== undefined && out > d.max) out = d.max;
  return out;
}

function bool(raw: Raw, schema: ComponentSchema, field: string): boolean {
  const v = raw[field];
  return typeof v === 'boolean' ? v : defaultOf<boolean>(schema, field);
}

function str(raw: Raw, schema: ComponentSchema, field: string): string {
  const v = raw[field];
  return typeof v === 'string' ? v : defaultOf<string>(schema, field);
}

/** A choice field; an authored value outside the choices falls back to the default and is reported. */
function choice<T extends string>(raw: Raw, schema: ComponentSchema, field: string, onInvalid?: (value: unknown) => void): T {
  const v = raw[field];
  const map = schema[field]?.enumMap;
  if (typeof v === 'string' && map && v in map) return map[v] as T;
  if (v !== undefined && v !== null && v !== '') onInvalid?.(v);
  return defaultOf<T>(schema, field);
}

/** Path id of a node's own `Path` component (`id`, else the node name — rv-path.ts). */
export function ownPathIdOf(node: Object3D): string | null {
  const p = (node.userData?.realvirtual as Raw | undefined)?.Path;
  if (!p || typeof p !== 'object') return null;
  const id = (p as Raw).id;
  return typeof id === 'string' && id.length > 0 ? id : (node.name || 'Path');
}

// ─── Reader ──────────────────────────────────────────────────────────

/**
 * Read every fleet component below `root` (inclusive) into a typed model.
 * `resolver` resolves the reference fields; without one they stay null.
 */
export function readFleetScene(root: Object3D, resolver?: FleetReferenceResolver | null): FleetSceneModel {
  const issues: FleetSceneIssue[] = [];
  const fleets: FleetSettings[] = [];
  const stations: TransferStationModel[] = [];
  const chargers: ChargerModel[] = [];
  const waitPoints: WaitPointModel[] = [];
  const forklifts: ForkliftProfileModel[] = [];
  const batteries: BatteryProfileModel[] = [];

  const ref = (node: Object3D, id: string, raw: Raw, field: string): Object3D | null => {
    const value = raw[field];
    if (!isComponentReference(value)) return null;
    if (!resolver) return null;
    // Scope = the node: the registry walks up to the enclosing registered scope root.
    const res = resolver.resolve(value as ComponentRef, node, node);
    const hit = res.node ?? res.drive?.node ?? res.sensor?.node
      ?? ((res.component as { node?: Object3D } | null | undefined)?.node ?? null);
    if (!hit) {
      issues.push({
        code: 'fleet-unresolved-reference', node: id,
        message: `${id}: reference ${field} does not resolve.`,
      });
    }
    return hit ?? null;
  };

  const pick = <T extends string>(id: string, raw: Raw, schema: ComponentSchema, field: string): T =>
    choice<T>(raw, schema, field, (value) => issues.push({
      code: 'fleet-invalid-value', node: id,
      message: `${id}: ${field} "${String(value)}" is not one of ${Object.keys(schema[field]?.enumMap ?? {}).join(', ')}; the default is used.`,
    }));

  const stubOf = (node: Object3D, id: string, raw: Raw, schema: ComponentSchema): string | null => {
    const authored = str(raw, schema, 'PathId').trim();
    const pathId = authored || ownPathIdOf(node);
    if (!pathId) {
      issues.push({ code: 'fleet-missing-path', node: id, message: `${id}: no PathId and no Path on the node.` });
    }
    return pathId;
  };

  root.traverse((node) => {
    if (!node.userData?.realvirtual) return;
    const id = NodeRegistry.computeNodePath(node);

    for (const raw of configsOf(node, FLEET_TYPE)) {
      const lengthMm = num(raw, FLEET_SCHEMA, 'DesignVehicleLengthMm');
      const widthMm = num(raw, FLEET_SCHEMA, 'DesignVehicleWidthMm');
      if ((lengthMm > 0) !== (widthMm > 0)) {
        issues.push({ code: 'fleet-design-vehicle-incomplete', node: id,
          message: `${id}: DesignVehicleLengthMm (${lengthMm}) and DesignVehicleWidthMm (${widthMm}) must both be positive or both zero.` });
      }
      fleets.push({
        id, node,
        designVehicle: lengthMm > 0 && widthMm > 0 ? { lengthMm, widthMm } : null,
        designLoadOffsetMm: num(raw, FLEET_SCHEMA, 'DesignLoadOffsetMm'),
        enabled: bool(raw, FLEET_SCHEMA, 'Enabled'),
        vehicleSelection: pick(id, raw, FLEET_SCHEMA, 'VehicleSelection'),
        charging: pick(id, raw, FLEET_SCHEMA, 'Charging'),
        waitLimitSec: num(raw, FLEET_SCHEMA, 'WaitLimitSec'),
        targetWaitLimitSec: num(raw, FLEET_SCHEMA, 'TargetWaitLimitSec'),
        chargeWaitLimitSec: num(raw, FLEET_SCHEMA, 'ChargeWaitLimitSec'),
        standstillLimitSec: num(raw, FLEET_SCHEMA, 'StandstillLimitSec'),
      });
    }

    for (const raw of configsOf(node, TRANSFER_STATION_TYPE)) {
      const S = TRANSFER_STATION_SCHEMA;
      const partnerType = pick<PartnerType>(id, raw, S, 'PartnerType');
      // Empty Partner on a conveyor station = this node; an authored but unresolved one stays null.
      const partnerAuthored = isComponentReference(raw.Partner);
      const partnerRef = ref(node, id, raw, 'Partner');
      stations.push({
        id, node,
        dockPort: str(raw, S, 'DockPort').trim(),
        name: str(raw, S, 'StationName').trim() || node.name,
        role: pick<TransferRole>(id, raw, S, 'Role'),
        pathId: stubOf(node, id, raw, S),
        partnerType,
        partner: partnerType === 'Floor' ? null : partnerAuthored ? partnerRef : node,
        partnerEnd: pick<PartnerEnd>(id, raw, S, 'PartnerEnd'),
        handlingHeightMm: num(raw, S, 'HandlingHeightMm'),
        approach: pick<Approach>(id, raw, S, 'Approach'),
        group: str(raw, S, 'Group').trim(),
        seat: ref(node, id, raw, 'SeatNode'),
      });
    }

    for (const raw of configsOf(node, CHARGER_TYPE)) {
      chargers.push({
        id, node,
        pathId: stubOf(node, id, raw, CHARGER_SCHEMA),
        chargeRatePerMin: num(raw, CHARGER_SCHEMA, 'ChargeRatePerMin'),
      });
    }

    for (const raw of configsOf(node, WAIT_POINT_TYPE)) {
      waitPoints.push({
        id, node,
        pathId: stubOf(node, id, raw, WAIT_POINT_SCHEMA),
        capacity: Math.max(1, Math.round(num(raw, WAIT_POINT_SCHEMA, 'Capacity'))),
        precedence: pick<WaitPrecedence>(id, raw, WAIT_POINT_SCHEMA, 'Precedence'),
      });
    }

    for (const raw of configsOf(node, FORKLIFT_PROFILE_TYPE)) {
      const F = FORKLIFT_PROFILE_SCHEMA;
      forklifts.push({
        id, node,
        lift: ref(node, id, raw, 'Lift'),
        forkAnchor: ref(node, id, raw, 'ForkAnchor'),
        liftRangeMm: num(raw, F, 'LiftRangeMm'),
        handlingDeltaMm: num(raw, F, 'HandlingDeltaMm'),
        liftSpeedEmptyMmS: num(raw, F, 'LiftSpeedEmptyMmS'),
        liftSpeedLoadedMmS: num(raw, F, 'LiftSpeedLoadedMmS'),
        travelHeightMm: num(raw, F, 'TravelHeightMm'),
        preLift: bool(raw, F, 'PreLift'),
        lowerAfterExit: bool(raw, F, 'LowerAfterExit'),
      });
    }

    for (const raw of configsOf(node, BATTERY_PROFILE_TYPE)) {
      const B = BATTERY_PROFILE_SCHEMA;
      batteries.push({
        id, node,
        startSoc: num(raw, B, 'StartSoc'),
        drivePerMin: num(raw, B, 'DrivePerMin'),
        liftPerM: num(raw, B, 'LiftPerM'),
        idlePerMin: num(raw, B, 'IdlePerMin'),
        threshold: num(raw, B, 'Threshold'),
        target: num(raw, B, 'Target'),
        reserveToCharger: num(raw, B, 'ReserveToCharger'),
        travelSlack: num(raw, B, 'TravelSlack'),
        chargerWaitReserveSec: num(raw, B, 'ChargerWaitReserveSec'),
      });
    }
  });

  const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  fleets.sort(byId);
  for (let i = 1; i < fleets.length; i++) {
    issues.push({
      code: 'fleet-duplicate', node: fleets[i]!.id,
      message: `${fleets[i]!.id}: a second Fleet is ignored; ${fleets[0]!.id} configures the scene.`,
    });
  }
  return {
    fleet: fleets[0] ?? null,
    stations: stations.sort(byId),
    chargers: chargers.sort(byId),
    waitPoints: waitPoints.sort(byId),
    forkliftProfiles: forklifts.sort(byId),
    batteryProfiles: batteries.sort(byId),
    issues,
  };
}

// ─── Vehicle lookup ──────────────────────────────────────────────────

/**
 * The profiles of the vehicle whose `Agv` sits on `agvNode`: the first profile
 * on the node itself or on an ancestor up to (and including) its instance
 * root (placement root or `InstanceScope` marker) — a profile on a placed
 * vehicle asset's root applies to the Agv below it, never to a neighbour.
 */
export function profilesOfVehicle(
  model: FleetSceneModel,
  agvNode: Object3D,
): { forklift: ForkliftProfileModel | null; battery: BatteryProfileModel | null } {
  const limit = instanceScopeNode(agvNode);
  let forklift: ForkliftProfileModel | null = null;
  let battery: BatteryProfileModel | null = null;
  for (let cur: Object3D | null = agvNode; cur && (!forklift || !battery); cur = cur.parent) {
    forklift ??= model.forkliftProfiles.find((p) => p.node === cur) ?? null;
    battery ??= model.batteryProfiles.find((p) => p.node === cur) ?? null;
    if (cur === limit) break;
  }
  return { forklift, battery };
}

/** The core battery model of a profile; `chargePerMin` comes from the charger (`Charger.ChargeRatePerMin`). */
export function batteryConfigOf(p: BatteryProfileModel, chargePerMin: number): BatteryConfig {
  return {
    startSoc: p.startSoc,
    drivePerMin: p.drivePerMin,
    liftPerM: p.liftPerM,
    idlePerMin: p.idlePerMin,
    chargePerMin,
    threshold: p.threshold,
    target: p.target,
    reserveToCharger: p.reserveToCharger,
    chargerWaitReserveSec: p.chargerWaitReserveSec,
  };
}
