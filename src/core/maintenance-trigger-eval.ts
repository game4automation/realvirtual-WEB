// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * maintenance-trigger-eval.ts — the pure rules of a maintenance trigger
 * (plan-522 Phase 7a). No viewer, no SignalStore, no clock of its own: the
 * MaintenancePlugin feeds signal values, time and travel in and reads levels
 * out, so every rule here is unit-testable with plain numbers.
 *
 * Levels: 0 ok, 1 upcoming, 2 due, 3 overdue.
 *
 * Accumulation contract per kind (G4):
 *   Count     number of matching edges of a Bool signal; an Int signal adds its
 *             positive difference (a PLC part counter). Never accelerated.
 *   Travel    |Δ position| of a drive, mm → km, × acceleration.
 *   RunTime   Δt while the signal is true (or, without signal, while the drive
 *             moves), s → h, × acceleration.
 *   Interval  Δt always (operating time of the scene), s → h, × acceleration.
 *   Signal    no counter: a matching edge (held for `DebounceSeconds`) fires.
 *   Threshold no counter: `value <Compare> Threshold` held for `DebounceSeconds`
 *             fires; re-arms only after falling back by `Hysteresis`.
 *
 * Counting kinds reach `upcoming` at `WarnAt × Interval`, `due` at `Interval`
 * and `overdue` at `Interval + OverdueAfter` (`OverdueAfter` 0 = never).
 * Signal / Threshold triggers become `overdue` when they have been due for
 * `OverdueAfter` seconds of trigger time; a Threshold trigger with a `Greater*`
 * comparison and a positive threshold is `upcoming` from `WarnAt × Threshold`.
 *
 * Combination (G5/G6): only participating triggers count. `Any` = the highest
 * level (ties: the smallest remaining fraction, then hierarchy order); `All` =
 * the lowest level (ties: hierarchy order). The deciding trigger delivers the remaining value. An empty set is
 * level 0 without a deciding trigger.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type MaintenanceTriggerKind = 'Signal' | 'Count' | 'RunTime' | 'Travel' | 'Threshold' | 'Interval';
export type MaintenanceTriggerEdge = 'Rising' | 'Falling' | 'Both';
export type MaintenanceTriggerCompare = 'GreaterThan' | 'GreaterOrEqual' | 'LessThan' | 'LessOrEqual' | 'Equals';
export type MaintenanceTriggerCombine = 'Any' | 'All';

/** 0 ok, 1 upcoming, 2 due, 3 overdue. */
export type MaintenanceLevel = 0 | 1 | 2 | 3;

export const MAINTENANCE_LEVEL_NAMES: readonly ['ok', 'upcoming', 'due', 'overdue'] = ['ok', 'upcoming', 'due', 'overdue'];

/** The kinds the evaluator knows (7a). */
export const MAINTENANCE_TRIGGER_KINDS: readonly MaintenanceTriggerKind[] = Object.freeze([
  'Count', 'Signal', 'RunTime', 'Travel', 'Threshold', 'Interval',
]);

/** Display unit of a counting kind's value and interval; '' for a count, null without counter. */
export function unitOfKind(kind: MaintenanceTriggerKind): 'km' | 'h' | '' | null {
  switch (kind) {
    case 'Travel': return 'km';
    case 'RunTime':
    case 'Interval': return 'h';
    case 'Count': return '';
    default: return null;
  }
}

/** True for the kinds whose value accumulates towards `Interval`. */
export function isCountingKind(kind: MaintenanceTriggerKind): boolean {
  return kind === 'Count' || kind === 'Travel' || kind === 'RunTime' || kind === 'Interval';
}

/** The evaluated configuration of one trigger (parsed, validated values). */
export interface TriggerRules {
  kind: MaintenanceTriggerKind;
  edge: MaintenanceTriggerEdge;
  /** Stays due until done. */
  latch: boolean;
  compare: MaintenanceTriggerCompare;
  threshold: number;
  hysteresis: number;
  /** Seconds of trigger time the condition must hold; 0 = at once. */
  debounceSeconds: number;
  /** Due limit of a counting kind (count / km / h); 0 = inactive. */
  interval: number;
  /** 0..1 share of `interval` for upcoming; 0 or ≥ 1 = no upcoming state. */
  warnAt: number;
  /** Excess over `interval` (counting) or seconds due (Signal / Threshold) for overdue; 0 = never. */
  overdueAfter: number;
  /** Standalone speed-up of Travel / RunTime / Interval; > 0. */
  acceleration: number;
}

/** Defaults of the component table (plan-522 Phase 7). */
export const DEFAULT_TRIGGER_RULES: Readonly<TriggerRules> = Object.freeze({
  kind: 'Count',
  edge: 'Rising',
  latch: true,
  compare: 'GreaterOrEqual',
  threshold: 0,
  hysteresis: 0,
  debounceSeconds: 0,
  interval: 0,
  warnAt: 0.9,
  overdueAfter: 0,
  acceleration: 1,
});

/** Mutable runtime state of one trigger. Allocated once per load, mutated in place. */
export interface TriggerState {
  /** Accumulated value (counting kinds), in the kind's unit. */
  value: number;
  /** Last seen signal value; null = not sampled yet (the next value is a baseline, no edge). */
  prev: boolean | number | null;
  /** Signal / Threshold: the condition currently holds (before debounce). */
  condition: boolean;
  /** Trigger time when the condition started to hold; -1 = not holding. */
  conditionSince: number;
  /** Signal / Threshold: fired (due). */
  fired: boolean;
  /** Trigger time when it fired; -1 = not fired. */
  firedAt: number;
  /** Threshold: may fire again (false after firing until the hysteresis band is left). */
  armed: boolean;
  /** Latch held after reaching due. */
  latched: boolean;
  /** Last numeric value seen (Threshold upcoming). */
  last: number;
}

export function createTriggerState(): TriggerState {
  return {
    value: 0,
    prev: null,
    condition: false,
    conditionSince: -1,
    fired: false,
    firedAt: -1,
    armed: true,
    latched: false,
    last: 0,
  };
}

// ─── Signal input ───────────────────────────────────────────────────────

/** True when a Bool transition `prev → next` matches the edge. */
export function edgeMatches(edge: MaintenanceTriggerEdge, prev: boolean, next: boolean): boolean {
  if (prev === next) return false;
  if (edge === 'Both') return true;
  return edge === 'Rising' ? next : !next;
}

/** `value <compare> threshold`; Equals uses a small absolute tolerance. */
export function compareValue(compare: MaintenanceTriggerCompare, value: number, threshold: number): boolean {
  switch (compare) {
    case 'GreaterThan': return value > threshold;
    case 'GreaterOrEqual': return value >= threshold;
    case 'LessThan': return value < threshold;
    case 'LessOrEqual': return value <= threshold;
    case 'Equals': return Math.abs(value - threshold) <= 1e-6;
    default: return false;
  }
}

/** True when the value has left the hysteresis band on the "not met" side (re-arm). */
function outsideHysteresis(rules: TriggerRules, value: number): boolean {
  const h = Math.max(0, rules.hysteresis);
  switch (rules.compare) {
    case 'GreaterThan':
    case 'GreaterOrEqual': return value < rules.threshold - h || (h === 0 && !compareValue(rules.compare, value, rules.threshold));
    case 'LessThan':
    case 'LessOrEqual': return value > rules.threshold + h || (h === 0 && !compareValue(rules.compare, value, rules.threshold));
    case 'Equals': return Math.abs(value - rules.threshold) > 1e-6 + h;
    default: return true;
  }
}

function toNumber(v: boolean | number): number {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}

/**
 * Feed one signal value (G2: the first sample is the baseline — a level that is
 * already high is NOT an edge). `now` = trigger time in seconds.
 * Returns true when the trigger's state changed in a way that can move its level.
 */
export function applySignalValue(rules: TriggerRules, s: TriggerState, value: boolean | number, now: number): boolean {
  const prev = s.prev;
  s.prev = value;
  switch (rules.kind) {
    case 'Count': {
      if (prev === null) return false;
      if (typeof value === 'number' && typeof prev === 'number') {
        const d = value - prev;
        if (d > 0 && Number.isFinite(d)) { s.value += d; return true; }
        return false;
      }
      if (edgeMatches(rules.edge, toNumber(prev) !== 0, toNumber(value) !== 0)) { s.value += 1; return true; }
      return false;
    }
    case 'Signal': {
      const level = toNumber(value) !== 0;
      if (prev === null) {
        s.condition = false;
        s.conditionSince = -1;
        return false;
      }
      const prevLevel = toNumber(prev) !== 0;
      if (edgeMatches(rules.edge, prevLevel, level)) {
        // A new matching edge: the level it produced must now hold for the debounce.
        s.condition = true;
        s.conditionSince = now;
        return tickDebounce(rules, s, now) || true;
      }
      if (level !== prevLevel) {
        // The level that fired (or was pending) went away.
        s.condition = false;
        s.conditionSince = -1;
        if (s.fired && !rules.latch) { s.fired = false; s.firedAt = -1; return true; }
      }
      return false;
    }
    case 'Threshold': {
      const v = toNumber(value);
      s.last = v;
      const met = compareValue(rules.compare, v, rules.threshold);
      if (!s.armed && outsideHysteresis(rules, v)) {
        s.armed = true;
        if (s.fired && !rules.latch) { s.fired = false; s.firedAt = -1; }
      }
      if (met && s.armed) {
        if (!s.condition) { s.condition = true; s.conditionSince = now; }
      } else {
        s.condition = false;
        s.conditionSince = -1;
      }
      tickDebounce(rules, s, now);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Debounce step of Signal / Threshold: fire once the condition held for
 * `debounceSeconds`. Returns true when the trigger fired now.
 */
export function tickDebounce(rules: TriggerRules, s: TriggerState, now: number): boolean {
  if (!s.condition || s.fired || s.conditionSince < 0) return false;
  if (now - s.conditionSince + 1e-9 < Math.max(0, rules.debounceSeconds)) return false;
  s.fired = true;
  s.firedAt = now;
  s.armed = false;
  s.condition = false;
  s.conditionSince = -1;
  return true;
}

// ─── Level + remaining ──────────────────────────────────────────────────

/** Level of one trigger (latch included). */
export function levelOf(rules: TriggerRules, s: TriggerState, now: number): MaintenanceLevel {
  let level: MaintenanceLevel = 0;
  if (isCountingKind(rules.kind)) {
    const interval = rules.interval;
    if (!(interval > 0)) return 0;
    const v = s.value;
    if (rules.overdueAfter > 0 && v >= interval + rules.overdueAfter) level = 3;
    else if (v >= interval) level = 2;
    else if (rules.warnAt > 0 && rules.warnAt < 1 && v >= rules.warnAt * interval) level = 1;
    if (level >= 2 && rules.latch) s.latched = true;
    if (s.latched && level < 2) level = 2;
    return level;
  }
  if (s.fired) {
    level = rules.overdueAfter > 0 && s.firedAt >= 0 && now - s.firedAt >= rules.overdueAfter ? 3 : 2;
    return level;
  }
  if (rules.kind === 'Threshold' && rules.warnAt > 0 && rules.warnAt < 1 && rules.threshold > 0
    && (rules.compare === 'GreaterThan' || rules.compare === 'GreaterOrEqual')
    && s.armed && s.last >= rules.warnAt * rules.threshold) {
    return 1;
  }
  return 0;
}

/**
 * Remaining value until due, in the kind's unit (G6). Counting kinds:
 * `max(0, interval − value)`; Signal / Threshold: 0 when due, else −1.
 */
export function remainingOf(rules: TriggerRules, s: TriggerState, level: MaintenanceLevel): number {
  if (isCountingKind(rules.kind)) return rules.interval > 0 ? Math.max(0, rules.interval - s.value) : -1;
  return level >= 2 ? 0 : -1;
}

/** `1 − value / interval` of a counting kind (≤ 0 once due); Signal / Threshold: 0 when due, else 1. */
export function remainingFractionOf(rules: TriggerRules, s: TriggerState, level: MaintenanceLevel): number {
  if (isCountingKind(rules.kind)) return rules.interval > 0 ? 1 - s.value / rules.interval : 1;
  return level >= 2 ? 0 : 1;
}

/** One participant of {@link combineLevels}. */
export interface CombineInput {
  level: MaintenanceLevel;
  remainingFraction: number;
}

/**
 * Combine participants (hierarchy order) — returns the index of the deciding
 * trigger, −1 for an empty set. The procedure level is `inputs[index].level`.
 */
export function decidingIndex(mode: MaintenanceTriggerCombine, inputs: ArrayLike<CombineInput>): number {
  let best = -1;
  for (let i = 0; i < inputs.length; i++) {
    if (best < 0) { best = i; continue; }
    const a = inputs[i];
    const b = inputs[best];
    if (mode === 'All') {
      if (a.level < b.level) best = i;
    } else if (a.level > b.level || (a.level === b.level && a.remainingFraction < b.remainingFraction)) {
      best = i;
    }
  }
  return best;
}

/** Done: counter to 0, latch and fired state cleared. A Threshold re-arms only below the hysteresis band. */
export function completeTrigger(rules: TriggerRules, s: TriggerState): void {
  s.value = 0;
  s.latched = false;
  s.fired = false;
  s.firedAt = -1;
  s.condition = false;
  s.conditionSince = -1;
  if (rules.kind === 'Threshold') s.armed = outsideHysteresis(rules, s.last);
}

/**
 * Restart the baselines after a simulation reset, model change or live switch
 * (G3): the counter stays, the next signal sample is a baseline again and a
 * running debounce starts over. A condition that still holds is re-sampled by
 * the caller through {@link applySignalValue}.
 */
export function rebaseTrigger(s: TriggerState): void {
  s.prev = null;
  s.condition = false;
  s.conditionSince = -1;
}

// ─── Accumulation helpers ───────────────────────────────────────────────

/** mm of linear travel per km. */
export const MM_PER_KM = 1_000_000;
/** Seconds per hour. */
export const S_PER_H = 3600;

/**
 * Add one fixed step to a counting kind. `dtS` = trigger time step in seconds,
 * `travelMm` = |Δ position| of the drive, `active` = RunTime's condition
 * (signal true / drive moving), `acc` = effective acceleration (1 when live).
 * Returns true when the value moved.
 */
export function accumulate(rules: TriggerRules, s: TriggerState, dtS: number, travelMm: number, active: boolean, acc: number): boolean {
  switch (rules.kind) {
    case 'Travel':
      if (!(travelMm > 1e-9)) return false;
      s.value += (travelMm / MM_PER_KM) * acc;
      return true;
    case 'RunTime':
      if (!active || !(dtS > 0)) return false;
      s.value += (dtS / S_PER_H) * acc;
      return true;
    case 'Interval':
      if (!(dtS > 0)) return false;
      s.value += (dtS / S_PER_H) * acc;
      return true;
    default:
      return false;
  }
}
