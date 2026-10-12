// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Library robots as placements, for the Perf Line document (plan-492 Phase 6).
 *
 * The synthetic line's own robot farm draws six-axis robots as box primitives —
 * right for a measurement axis ("what do N moving six-axis drives cost"), wrong
 * for looking at a line. This module puts REAL robots beside the line: the
 * library `FanucCRX-10iA-L.glb` on the production placement path
 * (`PlacementInstancer.resolveBaked` + `materialize`), exactly as the cell
 * matrix does, with the same erratic drivers for motion and the same teardown.
 *
 * Deliberately a separate module and not a mode of `rv-cell-matrix.ts`: the
 * matrix owns ONE state per viewer and disposes it wholesale, while a robot row
 * lives next to a synthetic line whose lifecycle is the line builder's. The
 * primitives are shared (`rescopeComponentRefs`, `integratePlacedContent`).
 */
import { Group, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { PlacementRef } from '../rv-placement-instancer';
import type { RVDrive } from '../rv-drive';
import type { RVErraticDriver } from '../rv-erratic';
import { NodeRegistry } from '../rv-node-registry';
import { integratePlacedContent, canIntegratePlacedContent } from '../rv-placement-integrate';
import {
  DEFAULT_ROBOT_ASSET, DEFAULT_ROBOT_URL, rescopeComponentRefs, type CellMatrixHost,
} from './rv-cell-matrix';

export type RobotPlacementMotion = 'static' | 'erratic';

export interface RobotPlacementsConfig {
  /** How many robots. */
  count: number;
  /** World-space base position of robot `i`, written into `out`. */
  place(i: number, out: Vector3): Vector3;
  /** Yaw of robot `i` about Y in radians (default 0). */
  yaw?(i: number): number;
  motion: RobotPlacementMotion;
  /**
   * `random` (default): every axis draws a fresh random target inside its
   * authored MinPos/MaxPos each time it arrives, and robot `i` runs at its own
   * tempo (a deterministic spread of ±30 % on the authored axis speeds), so no
   * two robots move alike. `authored`: the asset's own behavior — the library
   * Fanuc authors `IterateBetweenMaxAndMin: true` on all six axes, which makes
   * every placed copy toggle min↔max in lockstep (Thomas, 2026-09-25: "all
   * move the same").
   */
  targets?: 'random' | 'authored';
  /** Where the row's root group goes (default: the current document root). */
  parent?: Object3D;
  robotAsset?: string;
  robotUrl?: string;
}

export interface RobotPlacementsStats {
  robots: number;
  /** Every drive the placements produced (axes, gripper fingers). */
  drives: number;
  /** Axes with an erratic behavior — the ones `setMotion` switches. */
  erraticAxes: number;
  materializeMs: number;
  motion: RobotPlacementMotion;
}

export interface RobotPlacementsHandle {
  root: Object3D;
  roots: Object3D[];
  stats: RobotPlacementsStats;
  /** Switch the robots between holding their pose and erratic motion. */
  setMotion(motion: RobotPlacementMotion): void;
  /** Give everything back: behaviors, drives, registry paths, placement instances, nodes. */
  dispose(): void;
}

type IntegrationHost = Parameters<typeof integratePlacedContent>[0];

const ROOT_NAME = 'PerfRobots';

/**
 * Place `count` library robots and hand back a handle. Resolves once the asset
 * is baked and every robot is materialised; the drivers are collected and the
 * axes parked at zero before this returns, so two builds start from the same
 * pose (see `rv-cell-matrix.ts`, "resetAxesToZero").
 */
export async function placeLibraryRobots(
  viewer: CellMatrixHost,
  cfg: RobotPlacementsConfig,
): Promise<RobotPlacementsHandle> {
  if (!Number.isFinite(cfg.count) || cfg.count < 0) throw new Error(`[robot-placements] count must be >= 0, got ${cfg.count}`);
  const t0 = performance.now();
  const ref: PlacementRef = { catalogId: cfg.robotAsset ?? DEFAULT_ROBOT_ASSET, glbUrl: cfg.robotUrl ?? DEFAULT_ROBOT_URL };
  const baked = await viewer.placements.resolveBaked(ref);

  const parent = cfg.parent ?? viewer.currentModelRoot ?? viewer.scene;
  const root = new Group();
  root.name = ROOT_NAME;
  parent.add(root);

  const roots: Object3D[] = [];
  const host = viewer as unknown as IntegrationHost;
  const pos = new Vector3();
  for (let i = 0; i < cfg.count; i++) {
    const placement = viewer.placements.createRoot(baked);
    placement.name = `Robot${i}`;
    root.add(placement);
    const id = `perfrobots:${placement.name}`;
    // The robot keeps its own base origin (pivot: false — multi-part assembly).
    viewer.placements.materialize(placement, baked, { id, label: placement.name, catalogId: ref.catalogId, pivot: false });
    // Placement-scoped component references BEFORE the components are built,
    // or `MasterDrive`-style refs of robot 0 would suffix-match into robot 7.
    rescopeComponentRefs(placement, NodeRegistry.computeNodePath(placement));
    if (canIntegratePlacedContent(host)) integratePlacedContent(host, placement);
    // Position LAST: `materialize()` reads world bounds while pivoting.
    placement.position.copy(cfg.place(i, pos));
    placement.rotation.y = cfg.yaw?.(i) ?? 0;
    roots.push(placement);
  }
  refreshWorldMatrices(root);

  // ── Runtime ──
  const registry = viewer.registry;
  const axes: Array<{ driver: RVErraticDriver; drive: RVDrive }> = [];
  const drives: RVDrive[] = [];
  const randomTargets = (cfg.targets ?? 'random') === 'random';
  const robotIndexOf = (node: Object3D): number => {
    for (let cur: Object3D | null = node; cur; cur = cur.parent) {
      const i = roots.indexOf(cur);
      if (i >= 0) return i;
    }
    return -1;
  };
  if (registry) {
    for (const { instance } of registry.getAll<RVErraticDriver>('Drive_ErraticPosition')) {
      const node = instance?.node;
      if (!node || !isUnder(node, root) || !instance.drive) continue;
      if (randomTargets) {
        instance.IterateBetweenMaxAndMin = false;
        // Deterministic per-robot tempo: robot i runs at 0.7 … 1.3 x the
        // authored axis speed, so six copies of one asset do not stay in step.
        const i = Math.max(0, robotIndexOf(node));
        instance.Speed *= 0.7 + 0.6 * tempoOf(i);
      }
      axes.push({ driver: instance, drive: instance.drive });
    }
    for (const { instance } of registry.getAll<RVDrive>('Drive')) {
      const node = instance?.node;
      if (node && isUnder(node, root)) drives.push(instance);
    }
  }

  const stats: RobotPlacementsStats = {
    robots: roots.length,
    drives: drives.length,
    erraticAxes: axes.length,
    materializeMs: performance.now() - t0,
    motion: cfg.motion,
  };

  const setMotion = (motion: RobotPlacementMotion): void => {
    const on = motion === 'erratic';
    for (const { driver, drive } of axes) {
      const list = drive.driveBehaviors as unknown as RVErraticDriver[];
      const at = list.indexOf(driver);
      if (on) {
        driver.resume();
        if (at < 0) list.push(driver);
      } else if (at >= 0) {
        list.splice(at, 1);
        drive.stop();   // hold the pose — no return to zero
      }
    }
    stats.motion = motion;
    viewer.markRenderDirty?.();
  };

  // Park every axis at zero once, then apply the requested motion.
  for (const { driver, drive } of axes) {
    drive.stop();
    drive.currentPosition = 0;
    drive.applyToNode?.();
    driver.resume();
  }
  setMotion(cfg.motion);
  refreshWorldMatrices(root);
  viewer.markShadowsDirty?.();
  viewer.markRenderDirty?.();

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // Behaviors first, while the drives are live.
    for (const { driver, drive } of axes) {
      const list = drive.driveBehaviors as unknown as RVErraticDriver[];
      const at = list.indexOf(driver);
      if (at >= 0) list.splice(at, 1);
    }
    const mine = new Set<RVDrive>(drives);
    for (const { drive } of axes) mine.add(drive);
    for (let i = viewer.drives.length - 1; i >= 0; i--) {
      if (mine.has(viewer.drives[i])) viewer.drives.splice(i, 1);
    }
    for (const drive of mine) drive.dispose?.();
    // Registry BEFORE the release (it walks the live graph).
    registry?.unregisterSubtree(root);
    for (const placement of roots) viewer.placements.release(placement);
    root.parent?.remove(root);
    viewer.markShadowsDirty?.();
    viewer.markRenderDirty?.();
  };

  return { root, roots, stats, setMotion, dispose };
}

/** Deterministic value in [0, 1) for robot `i` — a cheap integer hash, so the
 *  same row always gets the same tempo spread (reproducible builds). */
function tempoOf(i: number): number {
  let x = (i + 1) * 0x9e3779b1;
  x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function isUnder(node: Object3D | null | undefined, ancestor: Object3D): boolean {
  for (let cur: Object3D | null | undefined = node; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

/** Recompute world matrices under `root`, ignoring the loader's freeze flags (build-time only). */
function refreshWorldMatrices(root: Object3D): void {
  root.updateWorldMatrix(true, false);
  const walk = (node: Object3D): void => {
    for (const child of node.children) {
      if (child.matrixAutoUpdate) child.updateMatrix();
      child.matrixWorld.multiplyMatrices(node.matrixWorld, child.matrix);
      child.matrixWorldNeedsUpdate = false;
      walk(child);
    }
  };
  walk(root);
}
