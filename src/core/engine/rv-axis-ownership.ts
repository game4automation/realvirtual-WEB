// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive } from './rv-drive';

export type AxisOwner = object | string | number | symbol;

export interface AxisOwnershipParticipant {
  readonly label: string;
  readonly drives: readonly RVDrive[];
  isActive(): boolean;
  pause(owner: AxisOwner): void;
  resume(): void;
}

export class AxisOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AxisOwnershipError';
  }
}

const claims = new Map<RVDrive, AxisOwner>();
const byOwner = new Map<AxisOwner, Set<RVDrive>>();
const participants = new Set<AxisOwnershipParticipant>();

function driveLabel(drive: RVDrive): string {
  return drive.name || drive.node.name || '(unnamed drive)';
}

function ownerLabel(owner: AxisOwner): string {
  if (typeof owner === 'string' || typeof owner === 'number') return String(owner);
  if (typeof owner === 'symbol') return owner.description ?? owner.toString();
  const named = owner as { id?: unknown; name?: unknown; type?: unknown };
  return String(named.id ?? named.name ?? named.type ?? owner.constructor?.name ?? 'object');
}

function participantClaim(participant: AxisOwnershipParticipant): AxisOwner | null {
  for (const drive of participant.drives) {
    const owner = claims.get(drive);
    if (owner !== undefined) return owner;
  }
  return null;
}

/** Register an IK path (or another axis controller) for immediate pause/resume. */
export function registerAxisOwnershipParticipant(
  participant: AxisOwnershipParticipant,
): () => void {
  participants.add(participant);
  const owner = participantClaim(participant);
  if (owner !== null) participant.pause(owner);
  return () => { participants.delete(participant); };
}

/**
 * Atomically claim all axes. Validation completes before any drive is stopped,
 * so a competing second claimer cannot partially seize a robot.
 */
export function claimAxes(drives: readonly RVDrive[], owner: AxisOwner): void {
  const unique = [...new Set(drives)];
  const conflicts = unique
    .filter((drive) => {
      const current = claims.get(drive);
      return current !== undefined && current !== owner;
    })
    .sort((a, b) => driveLabel(a).localeCompare(driveLabel(b)));
  if (conflicts.length > 0) {
    const drive = conflicts[0];
    throw new AxisOwnershipError(
      `Axis '${driveLabel(drive)}' is already claimed by '${ownerLabel(claims.get(drive)!)}'; `
      + `claim by '${ownerLabel(owner)}' rejected`,
    );
  }

  let owned = byOwner.get(owner);
  if (!owned) {
    owned = new Set<RVDrive>();
    byOwner.set(owner, owned);
  }
  for (const drive of unique) {
    if (claims.get(drive) === owner) continue;
    drive.stop();
    drive.positionOverwrite = true;
    claims.set(drive, owner);
    owned.add(drive);
  }
  for (const participant of participants) {
    const controllingOwner = participantClaim(participant);
    if (controllingOwner !== null) participant.pause(controllingOwner);
  }
}

/** Release every axis held by one owner and resume paths with no remaining claim. */
export function releaseAxes(owner: AxisOwner): void {
  const owned = byOwner.get(owner);
  if (!owned) return;
  for (const drive of owned) {
    if (claims.get(drive) !== owner) continue;
    claims.delete(drive);
    drive.positionOverwrite = false;
  }
  byOwner.delete(owner);
  for (const participant of participants) {
    if (participantClaim(participant) === null) participant.resume();
  }
}

/** Lifecycle safety net for DES stop/reset/dispose/model-switch paths. */
export function releaseAllAxes(): void {
  for (const owner of [...byOwner.keys()]) releaseAxes(owner);
}

export function isAnyAxisOwned(drives: readonly RVDrive[]): boolean {
  return drives.some((drive) => claims.has(drive));
}

export function axisOwner(drive: RVDrive): AxisOwner | null {
  return claims.get(drive) ?? null;
}

/** Diagnostics/tests: number of currently claimed drive axes. */
export function claimedAxisCount(): number {
  return claims.size;
}
