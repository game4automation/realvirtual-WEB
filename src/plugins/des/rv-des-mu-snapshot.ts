// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { DESComponent } from './rv-des-component';
import type { DESMU, DESMUSnapshot } from './rv-des-mu';

export function serializeMU(mu: DESMU): DESMUSnapshot {
  const pos = mu.visual && !mu.visual.isInstanced
    ? (() => {
        const node = (mu.visual as { node: Object3D }).node;
        return [node.position.x, node.position.y, node.position.z] as [number, number, number];
      })()
    : mu.restoredPosition
      ? [...mu.restoredPosition] as [number, number, number]
      : [0, 0, 0] as [number, number, number];

  const quat = mu.visual && !mu.visual.isInstanced
    ? (() => {
        const node = (mu.visual as { node: Object3D }).node;
        return [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w] as [number, number, number, number];
      })()
    : mu.restoredQuaternion
      ? [...mu.restoredQuaternion] as [number, number, number, number]
      : [0, 0, 0, 1] as [number, number, number, number];

  return {
    id: mu.id,
    generation: mu.generation,
    customId: mu.customId,
    priority: mu.priority,
    currentComponentPath: mu.currentComponent?.path ?? null,
    routePaths: mu.route.map(c => c.path),
    routeStep: mu.routeStep,
    entryTime: mu.entryTime,
    plannedExitTime: mu.plannedExitTime,
    creationTime: mu.creationTime,
    totalTimeInSystem: mu.totalTimeInSystem,
    isBlocked: mu.isBlocked,
    isInTransit: mu.isInTransit,
    isProcessing: mu.isProcessing,
    isLoaded: mu.isLoaded,
    loadedOnPath: mu.loadedOn?.path ?? null,
    loadedOnNode: mu.loadedOnNode,
    childMUs: structuredClone(mu.childMUs),
    parentMU: mu.parentMU ? structuredClone(mu.parentMU) : null,
    ...(mu.carrierType !== undefined ? { carrierType: mu.carrierType } : {}),
    ...(mu.carrierCapacity !== undefined ? { carrierCapacity: mu.carrierCapacity } : {}),
    ...(mu.visualTemplateId !== undefined ? { visualTemplateId: mu.visualTemplateId } : {}),
    prop: structuredClone(mu.prop),
    componentsVisited: mu.componentsVisited,
    blockedCount: mu.blockedCount,
    totalBlockedTime: mu.totalBlockedTime,
    totalProcessingTime: mu.totalProcessingTime,
    totalTransitTime: mu.totalTransitTime,
    position: pos,
    quaternion: quat,
    ...(mu.forward ? { forward: [...mu.forward] as [number, number, number] } : {}),
    ...(mu._bugSize ? { _bugSize: [...mu._bugSize] as [number, number, number] } : {}),
  };
}

export function applyMUSnapshot(
  mu: DESMU,
  snap: DESMUSnapshot,
  compByPath: Map<string, DESComponent>,
): void {
  mu.generation = snap.generation ?? 0;
  mu.customId = snap.customId;
  mu.priority = snap.priority;
  mu.currentComponent = snap.currentComponentPath
    ? compByPath.get(snap.currentComponentPath) ?? null
    : null;
  mu.route = snap.routePaths
    .map(p => compByPath.get(p))
    .filter(Boolean) as DESComponent[];
  mu.routeStep = snap.routeStep;
  mu.entryTime = snap.entryTime;
  mu.plannedExitTime = snap.plannedExitTime;
  mu.creationTime = snap.creationTime;
  mu.totalTimeInSystem = snap.totalTimeInSystem;
  mu.isBlocked = snap.isBlocked;
  mu.isInTransit = snap.isInTransit;
  mu.isProcessing = snap.isProcessing;
  mu.isLoaded = snap.isLoaded;
  mu.loadedOnNode = snap.loadedOnNode;
  mu.childMUs = structuredClone(snap.childMUs ?? []);
  mu.parentMU = snap.parentMU ? structuredClone(snap.parentMU) : null;
  mu.carrierType = snap.carrierType;
  mu.carrierCapacity = snap.carrierCapacity;
  mu.visualTemplateId = snap.visualTemplateId;
  mu.prop = structuredClone(snap.prop);
  mu.componentsVisited = snap.componentsVisited;
  mu.blockedCount = snap.blockedCount;
  mu.totalBlockedTime = snap.totalBlockedTime;
  mu.totalProcessingTime = snap.totalProcessingTime;
  mu.totalTransitTime = snap.totalTransitTime;
  // Restore the cache itself, not a heading inferred from the visual: a fork
  // may have turned the visual since the last conveyor set its travel heading.
  if (snap.forward) mu.forward = [...snap.forward];
  else delete mu.forward;
  if (snap._bugSize) mu._bugSize = [...snap._bugSize];
  else delete mu._bugSize;

  // Restore visual position
  if (mu.visual && !mu.visual.isInstanced) {
    const node = (mu.visual as { node: Object3D }).node;
    node.position.set(snap.position[0], snap.position[1], snap.position[2]);
    node.quaternion.set(snap.quaternion[0], snap.quaternion[1], snap.quaternion[2], snap.quaternion[3]);
  } else {
    mu.restoredPosition = [...snap.position];
    mu.restoredQuaternion = [...snap.quaternion];
  }
}

// ── Node path helper ──

export function parentHierarchyVisuals(mus: DESMU[]): void {
  const byKey = new Map<string, DESMU>();
  for (const mu of mus) byKey.set(`${mu.id}:${mu.generation}`, mu);
  for (const child of mus) {
    if (!child.parentMU || !child.visual || child.visual.isInstanced) continue;
    const parent = byKey.get(`${child.parentMU.id}:${child.parentMU.gen}`);
    if (!parent?.visual || parent.visual.isInstanced) continue;
    const parentNode = (parent.visual as { node: Object3D }).node;
    const childNode = (child.visual as { node: Object3D }).node;
    parentNode.add(childNode);
  }
}

