// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { IDriveBehavior, RVDrive } from '../../core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../../core/engine/rv-drive-destination-motor';
import { RVDriveSimple } from '../../core/engine/rv-drive-simple';
import { RVDriveSpeed } from '../../core/engine/rv-drive-speed';
import { RVDriveCylinder } from '../../core/engine/rv-drive-cylinder';
import { wireNumberSignal, type WireResult } from '../../core/engine/rv-signal-wiring';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { slotFeedbackState, slotWrite } from '../../core/engine/rv-slot-io';

/** Numeric subscriptions are retained in adapter registration order. */
function inputReplayHandles(instance: object): [string, WireResult['unsubscribe']][] {
  const handles = (instance as { inputUnsubs?: WireResult['unsubscribe'][] }).inputUnsubs ?? [];
  return Object.entries(handles).filter(([, handle]) => typeof handle.replayArmed === 'boolean');
}

export function captureInputReplay(instance: object): Record<string, boolean> {
  return Object.fromEntries(inputReplayHandles(instance).map(([key, handle]) => [key, handle.replayArmed!]));
}

/** Changing arming never delivers a value or invokes a command. */
export function restoreInputReplay(instance: object, values: Record<string, boolean>): void {
  for (const [key, handle] of inputReplayHandles(instance)) handle.replayArmed = values[key];
}

export function captureSlotFeedback(instance: object): Record<string, boolean | number> {
  return Object.fromEntries([...(slotFeedbackState(instance) ?? [])]
    .filter(([, entry]) => entry.access === 'feedback').map(([field, entry]) => [field, entry.value]));
}

/** Restore caches without writes, listeners or commands. */
export function restoreSlotFeedback(instance: object, values: Record<string, boolean | number>): void {
  const fields = slotFeedbackState(instance);
  for (const [field, value] of Object.entries(values)) {
    const entry = fields?.get(field);
    if (entry?.access === 'feedback') entry.value = value;
  }
}

/** Command feedback uses the adapter's existing writer, without a motion tick. */
export function publishFeedbackNow(drive: RVDrive, owner: IDriveBehavior): void {
  if (!drive.eventDrivenFeedback) return;
  if (owner instanceof RVDriveDestinationMotor) owner.commandFeedbackWriter?.(drive);
  else if (owner instanceof RVDriveSimple) {
    // Direct-feedback listeners read through the same command-state view as wired slots.
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'readFeedbackSlot');
    const read = owner.readFeedbackSlot;
    owner.readFeedbackSlot = slot => slot === 'IsDriving'
      ? drive.isRunning || drive.jogForward || drive.jogBackward : read.call(owner, slot);
    try { owner.commandFeedbackWriter?.(drive); }
    finally {
      if (descriptor) Object.defineProperty(owner, 'readFeedbackSlot', descriptor);
      else delete (owner as Partial<RVDriveSimple>).readFeedbackSlot;
    }
  } else if (owner instanceof RVDriveSpeed) {
    slotWrite(owner, 'SignalIsDriving', owner.SignalIsDriving,
      owner.TargetSpeed !== 0 || drive.isRunning, owner.commandFeedbackWriter);
  } else if (owner instanceof RVDriveCylinder) owner.commandFeedbackWriter?.();
}

/** Polling remains unchanged in Continuous; DES observes command transitions before motion. */
export function subscribeDriveInputs(drive: RVDrive, store: SignalStore | null): () => void {
  const off: (() => void)[] = [];
  if (store) for (const owner of drive.driveBehaviors) if (owner instanceof RVDriveSpeed) {
    for (const [address, command] of [
      [owner.SignalTargetSpeed, (v: number) => owner.commandTargetSpeed(v)],
      [owner.SignalAcceleration, (v: number) => owner.commandAcceleration(v)],
    ] as const) off.push(wireNumberSignal(store, address, value => {
      if (drive.eventDrivenFeedback && drive.driveBehaviors.includes(owner)) command(value);
    }).unsubscribe);
  }
  return () => { for (const unsubscribe of off) unsubscribe(); };
}
