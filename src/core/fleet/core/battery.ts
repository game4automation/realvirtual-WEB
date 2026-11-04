// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * battery.ts — the fleet's battery model (plan-559 §2.3, A4). Pure, no Three/DOM.
 *
 * Ported 1:1 (formulas and the boundary rule) from the plan-612 PalletYard
 * model so the core reproduces its counters exactly (D8). Parameters come as a
 * configuration object — later from the `BatteryProfile` component (A4).
 *
 * State of charge (SOC) in percent; consumption in percentage points: driving
 * per minute, lifting per metre of fork travel, standing per minute. Charging
 * runs at a fixed rate up to `target`.
 *
 * Admission (`canAccept`): a vehicle takes an order only if
 *   soc − E(order) − max(E(way to the nearest charger), reserveToCharger)
 *       − E(standing chargerWaitReserveSec) ≥ 0,
 * where E(order) is what the caller puts into the order's {@link Consumption}
 * (travel incl. slack, reverse stub runs, lift strokes, pauses).
 */

/** Battery parameters (later `BatteryProfile` + `Charger.ChargeRatePerMin`). */
export interface BatteryConfig {
  /** SOC at start / after reset (%). */
  readonly startSoc: number;
  /** Consumption while driving (%-points per minute). */
  readonly drivePerMin: number;
  /** Consumption per metre of fork/lift travel (%-points per m). */
  readonly liftPerM: number;
  /** Consumption while standing (%-points per minute). */
  readonly idlePerMin: number;
  /** Charge rate (%-points per minute). */
  readonly chargePerMin: number;
  /** Below this SOC the vehicle must charge after its current order (%). */
  readonly threshold: number;
  /** Charging stops at this SOC; opportunity charging below it (%). */
  readonly target: number;
  /** Minimal reserve kept for the way to the charger (%-points). */
  readonly reserveToCharger: number;
  /** Assumed standing time at an occupied charger, reserved in the admission (s). */
  readonly chargerWaitReserveSec: number;
}

/** One stretch of work: seconds driving, metres of lift travel, seconds standing. */
export interface Consumption {
  driveSec: number;
  liftM: number;
  idleSec: number;
}

export type BatteryRates = Omit<BatteryConfig, 'startSoc'>;

/**
 * Admission boundary slack, taken over unchanged from plan-612 (`>= -1e-9`):
 * "exactly on the boundary counts as admissible" despite float rounding of
 * the energy sums. Kept for exact parity (D8).
 */
export const ADMISSION_EPSILON = 1e-9;

/** Percentage points `c` costs. */
export function energyOf(c: Consumption, cfg: BatteryRates): number {
  return (Math.max(0, c.driveSec) / 60) * cfg.drivePerMin
    + Math.max(0, c.liftM) * cfg.liftPerM
    + (Math.max(0, c.idleSec) / 60) * cfg.idlePerMin;
}

/** SOC after `c` — never below 0. */
export function consume(soc: number, c: Consumption, cfg: BatteryRates): number {
  return Math.max(0, soc - energyOf(c, cfg));
}

/** SOC after charging `sec` seconds — never above 100. */
export function chargeFor(soc: number, sec: number, cfg: BatteryRates): number {
  return Math.min(100, soc + (Math.max(0, sec) / 60) * cfg.chargePerMin);
}

/** Seconds to charge from `soc` to `target` (0 when already there). */
export function chargeTimeSec(soc: number, cfg: BatteryRates): number {
  return Math.max(0, cfg.target - soc) / cfg.chargePerMin * 60;
}

/** True when the vehicle must charge after its current order: `soc < threshold`. */
export function needsCharge(soc: number, cfg: BatteryRates): boolean {
  return soc < cfg.threshold;
}

/** True when charging now would add something (opportunity charging): `soc < target`. */
export function wantsCharge(soc: number, cfg: BatteryRates): boolean {
  return soc < cfg.target;
}

/** The energy a vehicle must still have AFTER an order: way to the charger + wait there. */
export function reserveAfterOrder(toCharger: Consumption, cfg: BatteryRates): number {
  const way = Math.max(energyOf(toCharger, cfg), cfg.reserveToCharger);
  const wait = energyOf({ driveSec: 0, liftM: 0, idleSec: cfg.chargerWaitReserveSec }, cfg);
  return way + wait;
}

/**
 * Admission rule: after the order the vehicle still reaches the nearest
 * charger (`toCharger`) and survives the assumed charger wait. Exactly on the
 * boundary counts as admissible.
 */
export function canAccept(soc: number, order: Consumption, toCharger: Consumption, cfg: BatteryRates): boolean {
  return soc - energyOf(order, cfg) - reserveAfterOrder(toCharger, cfg) >= -ADMISSION_EPSILON;
}

/** The smallest SOC that `canAccept` admits for this order (tests, diagnostics). */
export function minSocFor(order: Consumption, toCharger: Consumption, cfg: BatteryRates): number {
  return energyOf(order, cfg) + reserveAfterOrder(toCharger, cfg);
}

/** The model bound to one configuration — what strategies see (`StrategyContext.battery`). */
export interface BatteryModel {
  readonly config: BatteryRates;
  energyOf(c: Consumption): number;
  consume(soc: number, c: Consumption): number;
  chargeFor(soc: number, sec: number): number;
  chargeTimeSec(soc: number): number;
  needsCharge(soc: number): boolean;
  wantsCharge(soc: number): boolean;
  reserveAfterOrder(toCharger: Consumption): number;
  canAccept(soc: number, order: Consumption, toCharger: Consumption): boolean;
  minSocFor(order: Consumption, toCharger: Consumption): number;
}

/** Bind the pure functions to `cfg`. */
export function createBatteryModel(cfg: BatteryRates): BatteryModel {
  return {
    config: cfg,
    energyOf: (c) => energyOf(c, cfg),
    consume: (soc, c) => consume(soc, c, cfg),
    chargeFor: (soc, sec) => chargeFor(soc, sec, cfg),
    chargeTimeSec: (soc) => chargeTimeSec(soc, cfg),
    needsCharge: (soc) => needsCharge(soc, cfg),
    wantsCharge: (soc) => wantsCharge(soc, cfg),
    reserveAfterOrder: (toCharger) => reserveAfterOrder(toCharger, cfg),
    canAccept: (soc, order, toCharger) => canAccept(soc, order, toCharger, cfg),
    minSocFor: (order, toCharger) => minSocFor(order, toCharger, cfg),
  };
}
