// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * fleet-components.ts — the scene layer of the AGV fleet core (plan-559 Phase 3).
 *
 * Six web-only component schemas a scene author puts on nodes:
 *  - `Fleet`            scene-wide settings of the fleet core (strategies, wait limits)
 *  - `TransferStation`  a pick / drop / storage place at a stub of the path network
 *  - `Charger`          a charging stub
 *  - `WaitPoint`        a parking / charger-queue stub
 *  - `ForkliftProfile`  lift and fork behaviour of a vehicle asset
 *  - `BatteryProfile`   battery model of a vehicle asset
 *
 * Pure data: no factory, no runtime behaviour (pattern of
 * `rv-maintenance-components.ts`). The fleet core reads them late, after the
 * placements materialised, through `readFleetScene()` (fleet-scene-model.ts).
 * Fleet design dimensions/load offset and the station dock port also support path authoring.
 *
 * Deliberately NOT `defineMaterialFlow` (plan-559 SOL #6): none of these types
 * has a `MaterialFlowKind` or an adapter, so DES auto-connect never sees them
 * and none of them can accept an MU.
 *
 * Stubs are named by PATH-ID STRING, not by a ComponentReference (559 M1: a
 * reference from the layout into a placement is dead at init). Empty `PathId`
 * = the `Path` on the node carrying the component. This lets a
 * `TransferStation` sit on a conveyor placement's reference node and name its
 * stub in the layout (the PalletYard pattern of 612 CP1d-b, 559 M2 (3)).
 *
 * Reference fields (`Partner`, `SeatNode`, `Lift`, `ForkAnchor`) claim their
 * target node in the destructive bake (`bakeTarget: 'merge'`), so a fork anchor
 * or a floor seat survives without any plugin `bakeClaims()` (Lehre 612).
 *
 * Schemas are WEB-only: there is no Unity counterpart, so no rv-ODT `$def`
 * (same decision as the maintenance components, plan-522).
 */

import {
  registerComponentSchema,
  type ComponentCapabilities,
  type ComponentSchema,
} from '../../engine/rv-component-registry';

// ─── Type keys ───────────────────────────────────────────────────────

export const FLEET_TYPE = 'Fleet';
export const TRANSFER_STATION_TYPE = 'TransferStation';
export const CHARGER_TYPE = 'Charger';
export const WAIT_POINT_TYPE = 'WaitPoint';
export const FORKLIFT_PROFILE_TYPE = 'ForkliftProfile';
export const BATTERY_PROFILE_TYPE = 'BatteryProfile';

/** The six schemas this module registers. */
export const FLEET_COMPONENT_TYPES: readonly string[] = Object.freeze([
  FLEET_TYPE,
  TRANSFER_STATION_TYPE,
  CHARGER_TYPE,
  WAIT_POINT_TYPE,
  FORKLIFT_PROFILE_TYPE,
  BATTERY_PROFILE_TYPE,
]);

// ─── Choice lists (the inspector offers them as a selection) ─────────

/** Vehicle selection strategies of the core (a project replaces them via `definePlantPlugin`). */
export const VEHICLE_SELECTION_STRATEGIES: readonly string[] = Object.freeze(['nearest-feasible']);
/** Charging strategies of the core. */
export const CHARGING_STRATEGIES: readonly string[] = Object.freeze(['threshold-opportunity']);
export const TRANSFER_ROLES: readonly string[] = Object.freeze(['pick', 'drop', 'storage', 'both']);
export const PARTNER_TYPES: readonly string[] = Object.freeze(['Conveyor', 'Floor']);
export const PARTNER_ENDS: readonly string[] = Object.freeze(['tail', 'head']);
export const APPROACHES: readonly string[] = Object.freeze(['reverse', 'forward']);
export const WAIT_PRECEDENCES: readonly string[] = Object.freeze(['charge-queue-first', 'arrival-order']);

const enumOf = (values: readonly string[]): Record<string, string> =>
  Object.fromEntries(values.map((v) => [v, v]));

// ─── Schemas ─────────────────────────────────────────────────────────

/**
 * Scene-wide settings. Wait limits are per kind of wait, measured against the
 * PalletYard soak (3 sim days, 559 `open:`): legitimate waits for an occupied
 * target reach 2741 s and for a charger 2639 s, fork waits stay below 3 s. A
 * global 60 s would report in normal operation, so only short step waits use
 * `WaitLimitSec`. 0 = never reported.
 */
export const FLEET_SCHEMA: ComponentSchema = {
  DesignVehicleLengthMm: { type: 'number', default: 0, min: 0, max: 20000, step: 10, unit: 'mm', label: 'Design vehicle length' },
  DesignVehicleWidthMm: { type: 'number', default: 0, min: 0, max: 10000, step: 10, unit: 'mm', label: 'Design vehicle width' },
  /** Fallback value; measured forklifts take precedence. Runtime fields have no tooltip/description key. */
  DesignLoadOffsetMm: { type: 'number', default: 0, min: -5000, max: 5000, step: 1, unit: 'mm', label: 'Design load offset' },
  Enabled: { type: 'boolean', default: true },
  VehicleSelection: { type: 'enum', enumMap: enumOf(VEHICLE_SELECTION_STRATEGIES), default: 'nearest-feasible' },
  Charging: { type: 'enum', enumMap: enumOf(CHARGING_STRATEGIES), default: 'threshold-opportunity' },
  /** Default limit of a step wait (fork, stub exit) before a Problems entry. */
  WaitLimitSec: { type: 'number', default: 60, unit: 's', min: 0 },
  /** Limit of a wait for an occupied target (drop place full). */
  TargetWaitLimitSec: { type: 'number', default: 3600, unit: 's', min: 0 },
  /** Limit of a wait for a free charger. */
  ChargeWaitLimitSec: { type: 'number', default: 3600, unit: 's', min: 0 },
  /** Limit of a vehicle standing still in a traffic halt with a plan (a hang). */
  StandstillLimitSec: { type: 'number', default: 120, unit: 's', min: 0 },
};

export const TRANSFER_STATION_SCHEMA: ComponentSchema = {
  DockPort: { type: 'string', default: '', label: 'Dock port' },
  /** Short name for logs and HMI (e.g. `A1`); empty = the node name. */
  StationName: { type: 'string', default: '' },
  Role: { type: 'enum', enumMap: enumOf(TRANSFER_ROLES), default: 'both' },
  /** Path id of the stub the vehicle serves the station from; empty = the Path on this node. */
  PathId: { type: 'string', default: '' },
  /** `Conveyor` = load handed to / taken from a conveyor; `Floor` = a place on the ground. */
  PartnerType: { type: 'enum', enumMap: enumOf(PARTNER_TYPES), default: 'Conveyor' },
  /** The conveyor node; empty with `Conveyor` = this node (e.g. a conveyor placement's reference node). */
  Partner: { type: 'componentRef', bakeTarget: 'merge', refTarget: 'node' },
  /** `tail` = take from the conveyor end, `head` = hand to the conveyor start. */
  PartnerEnd: { type: 'enum', enumMap: enumOf(PARTNER_ENDS), default: 'tail' },
  /** Lift position at which the fork touches the load's carrying face. */
  HandlingHeightMm: { type: 'number', default: 0, unit: 'mm', min: 0 },
  Approach: { type: 'enum', enumMap: enumOf(APPROACHES), default: 'reverse' },
  /** Station group, e.g. `Buffer`, `Shipping`; empty = none. */
  Group: { type: 'string', default: '' },
  /** Pose of a load set down on the floor; empty = the end of the stub. */
  SeatNode: { type: 'componentRef', bakeTarget: 'merge', refTarget: 'node' },
};

export const CHARGER_SCHEMA: ComponentSchema = {
  /** Path id of the charging stub; empty = the Path on this node. */
  PathId: { type: 'string', default: '' },
  ChargeRatePerMin: { type: 'number', default: 5, unit: '%/min', min: 0 },
};

export const WAIT_POINT_SCHEMA: ComponentSchema = {
  /** Path id of the wait stub; empty = the Path on this node. */
  PathId: { type: 'string', default: '' },
  Capacity: { type: 'number', default: 1, min: 1, step: 1 },
  /** `charge-queue-first` = a vehicle queuing for a charger displaces a parked one. */
  Precedence: { type: 'enum', enumMap: enumOf(WAIT_PRECEDENCES), default: 'charge-queue-first' },
};

/** Defaults = the PalletYard stacker (plan-612 `PALLET_YARD_CONFIG.vehicle`). */
export const FORKLIFT_PROFILE_SCHEMA: ComponentSchema = {
  /** The lift drive. */
  Lift: { type: 'componentRef', bakeTarget: 'merge' },
  /** Seat node of the carried load. */
  ForkAnchor: { type: 'componentRef', bakeTarget: 'merge', refTarget: 'node' },
  LiftRangeMm: { type: 'number', default: 1200, unit: 'mm', min: 0 },
  /** Approach below / lift above the handling height. */
  HandlingDeltaMm: { type: 'number', default: 30, unit: 'mm', min: 0 },
  LiftSpeedEmptyMmS: { type: 'number', default: 300, unit: 'mm/s', min: 0 },
  LiftSpeedLoadedMmS: { type: 'number', default: 150, unit: 'mm/s', min: 0 },
  /** Fork height during travel. */
  TravelHeightMm: { type: 'number', default: 150, unit: 'mm', min: 0 },
  /** Lift to the approach height while driving to the station. */
  PreLift: { type: 'boolean', default: true },
  /** Lower to travel height only after the stub zone is free again. */
  LowerAfterExit: { type: 'boolean', default: true },
};

/** Defaults = the PalletYard battery (plan-612 `PALLET_YARD_CONFIG.battery`), StartSoc 100. */
export const BATTERY_PROFILE_SCHEMA: ComponentSchema = {
  StartSoc: { type: 'number', default: 100, unit: '%', min: 0, max: 100 },
  DrivePerMin: { type: 'number', default: 1.2, unit: '%/min', min: 0 },
  LiftPerM: { type: 'number', default: 0.05, unit: '%/m', min: 0 },
  IdlePerMin: { type: 'number', default: 0.2, unit: '%/min', min: 0 },
  /** Below this the vehicle charges after its current order. */
  Threshold: { type: 'number', default: 30, unit: '%', min: 0, max: 100 },
  /** Charging stops here; opportunity charging below it. */
  Target: { type: 'number', default: 80, unit: '%', min: 0, max: 100 },
  /** Always kept for the way to the charger. */
  ReserveToCharger: { type: 'number', default: 5, unit: '%', min: 0, max: 100 },
  /** Factor on the route time in the admission check. */
  TravelSlack: { type: 'number', default: 1.5, min: 1 },
  /** Assumed wait at an occupied charger, reserved in the admission check. */
  ChargerWaitReserveSec: { type: 'number', default: 600, unit: 's', min: 0 },
};

// ─── Registration ────────────────────────────────────────────────────

/** Fleet badge colour (amber, distinct from transport surfaces). */
const FLEET_BADGE_COLOR = '#f9a825';

/** One family in the Transport category (chip: Transport ▸ Fleet). */
const FLEET_CAPABILITIES: ComponentCapabilities = {
  authorable: true,
  pick: 'none',
  ui: { category: 'transport', filter: 'Fleet', badge: FLEET_BADGE_COLOR },
};

registerComponentSchema(FLEET_TYPE, FLEET_SCHEMA, FLEET_CAPABILITIES);
registerComponentSchema(TRANSFER_STATION_TYPE, TRANSFER_STATION_SCHEMA, FLEET_CAPABILITIES);
registerComponentSchema(CHARGER_TYPE, CHARGER_SCHEMA, FLEET_CAPABILITIES);
registerComponentSchema(WAIT_POINT_TYPE, WAIT_POINT_SCHEMA, FLEET_CAPABILITIES);
registerComponentSchema(FORKLIFT_PROFILE_TYPE, FORKLIFT_PROFILE_SCHEMA, FLEET_CAPABILITIES);
registerComponentSchema(BATTERY_PROFILE_TYPE, BATTERY_PROFILE_SCHEMA, FLEET_CAPABILITIES);
