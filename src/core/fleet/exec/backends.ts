// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * backends.ts — the kernel half of the fleet executor (plan-559 §2.4, V6).
 *
 * The {@link FleetJobRunner} is kernel-neutral: everything that touches MUs,
 * conveyors, the fork drive or the simulation clock goes through ONE adapter
 * set per kernel, composed directly by the binding (no registry, V6):
 *
 *  - DES:        `src/plugins/des/fleet/{des-sim-clock,des-lift,des-handover}.ts`
 *  - continuous: `ContinuousSimClock` + `src/core/fleet/continuous/lift.ts` + the
 *                project's continuous hand-over (until plan-559 Phase 7).
 *
 * Station ids are the ids of the dispatcher's stations; MU ids are strings.
 */

import type { Object3D } from 'three';
import type { SimClock } from '../core/sim-clock';

export type StrokeCont =
  | { k: 'none' | 'finishStay' }
  | { k: 'approachReady'; a: number }
  | { k: 'pickTouch' | 'retrieveTouch'; station: string; h: number }
  | { k: 'deliver'; station: string };
export type LiftDone = { e: number; hj: number; cont: StrokeCont };
export interface PickWait { v: string; h: number; hj: number }

/**
 * The hand-over of MUs between a vehicle's fork and the stations: production
 * at a pick station, pick at its end, put on a drop station's head, store /
 * retrieve on storage places. Every method acts NOW (inside a clock or dock
 * event); a refusal never moves anything.
 */
export interface HandoverBackend {
  /** Takt release at pick station `station`: one MU onto its head; false = head occupied. */
  produce(station: string): boolean;
  /** The head of pick station `station` takes a new MU now. */
  headFree(station: string): boolean;
  /**
   * Dock `vehicle` at the end of pick station `station`; `onPicked` runs when the
   * MU is on the fork (now or at its arrival) — from inside the kernel's release
   * stack, so the caller continues as an own clock event.
   */
  awaitPick(station: string, vehicle: string, wait: PickWait): void;
  setPickHandler(handler: (output: string, wait: PickWait, mu: string) => void): void;
  /** Withdraw `vehicle`'s pending {@link awaitPick} at `station` (its job was taken, SOL #8); no-op without one. */
  cancelPick?(station: string, vehicle: string): void;
  /** Drop station `station` can take an MU now (its head is free). */
  inputFree(station: string): boolean;
  /** Current input MU, when cheaply available (timeout diagnostics only). */
  inputOccupant?(station: string): string | null;
  /** Put the carried MU of `vehicle` on the head of drop station `station`; false = refused (stays on the fork). */
  putOnHead(vehicle: string, station: string): boolean;
  /** Run / stop drop station `station` (a pause); `run = true` also pulls a parked MU on. */
  setInputRun(station: string, run: boolean): void;
  /** Fork of `vehicle` → storage place `slot`. */
  store(vehicle: string, slot: string): boolean;
  /** Storage place `slot` → fork of `vehicle`; the MU id or null. */
  retrieve(slot: string, vehicle: string): string | null;
  /** MU id on the fork of `vehicle`, or null. */
  carried(vehicle: string): string | null;
  /** MU id on storage place `slot`, or null. */
  onSlot(slot: string): string | null;
  /** Seat every held MU on its owner (per frame). Returns the number fixed. */
  reconcile(): number;
  /** Scene root node of a vehicle. */
  vehicleNode(vehicle: string): Object3D | null;
  /** "An MU stands at the end of pick station `station`" — set by the runner. */
  onPalletReady: ((station: string, mu: string) => void) | null;
  /**
   * Drop station `station` became free (plan-559 S3) — set by the runner. The
   * event is permanently wired, so a vehicle refused by {@link putOnHead} is woken
   * by the next free event without a subscribe/refuse race.
   */
  onInputFreed: ((station: string) => void) | null;
  /** Before the engine reset: free every held MU visual (nothing may hang on a fork). */
  releaseVisuals(): void;
  /** After the engine reset: forget every MU / wiring state. */
  resetState(): void;
  dispose(): void;
}

/** The fork drive of the vehicles — strokes on SIMULATION time. */
export interface LiftBackend {
  /** Current fork position (mm). */
  position(vehicle: string): number;
  /** Stroke to `toMm` at `speedMmS`; `done` runs at the end (sim time). */
  move(vehicle: string, toMm: number, speedMmS: number, done: LiftDone): void;
  setDoneHandler(handler: (vehicle: string, done: LiftDone) => void): void;
  /** Abort a running stroke (no `done`). */
  cancel(vehicle: string): void;
  /** Put the fork to `mm` at once (reset). */
  snap(vehicle: string, mm: number): void;
}

/** The part of an `RVDrive` a lift backend writes. */
export interface LiftDrive {
  positionOverwrite: boolean;
  currentPosition: number;
  applyToNode(): void;
}

/** The adapters of ONE kernel, composed directly by the binding (V6: no registry). */
export interface FleetKernelAdapters {
  readonly kind: 'des' | 'continuous';
  readonly clock: SimClock;
  readonly lift: LiftBackend;
  readonly handover: HandoverBackend;
}
