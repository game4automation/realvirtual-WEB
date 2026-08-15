// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * slot-second-pass-repair — a slot mapping whose component moved gets ONE
 * candidate and no automatic decision (plan-425 F3, test 9.3, "case B").
 *
 * The dedup cases below are the reason this pass never binds by itself.
 * Three.js deduplicates node names per FILE, so whether an object ends up called
 * `Gripper` or `Gripper_1` is decided by traversal order — an accident of
 * export, not a property of the machine. A leaf-name match is therefore capable
 * of producing a single, confident, WRONG answer, and the cost of that answer is
 * a signal wired to the wrong actuator.
 *
 * So the contract this file pins is deliberately meek: exactly one match is an
 * OFFER, everything else is silence, and no path through the second pass
 * changes a binding without a human saying so.
 */

import { describe, it, expect } from 'vitest';
import { findRepairCandidate, normalizedLeaf } from '../src/core/engine/rv-binding-repair';

const SLOT = 'Forward';

function slot(componentPath: string, componentType = 'Drive_Simple') {
  return { slot: SLOT, componentPath, componentType };
}

/** A mapping saved against a path that no longer exists. */
const MOVED = { slot: SLOT, componentPath: 'Cell/OldGroup/Gripper', componentType: 'Drive_Simple' };

describe('normalizedLeaf', () => {
  it('compares the last segment, sanitised the way Three.js sanitises', () => {
    // A mapping written against the original glTF name must still match the
    // name Three assigned — otherwise every dotted component name is a miss.
    expect(normalizedLeaf('Cell/Group/Drive.X')).toBe(normalizedLeaf('Other/DriveX'));
  });

  it('keeps a dedup suffix — `Gripper` and `Gripper_1` are different objects', () => {
    expect(normalizedLeaf('A/Gripper')).not.toBe(normalizedLeaf('B/Gripper_1'));
  });
});

describe('findRepairCandidate', () => {
  it('offers the single component of the same type, slot and leaf name', () => {
    const found = findRepairCandidate(MOVED, [
      slot('Cell/Machine/Gripper'),
      slot('Cell/Machine/Conveyor'),
    ]);
    expect(found).toEqual({ found: true, componentPath: 'Cell/Machine/Gripper' });
  });

  it('offers nothing when nothing matches', () => {
    expect(findRepairCandidate(MOVED, [slot('Cell/Machine/Conveyor')]))
      .toEqual({ found: false, reason: 'no-candidate' });
  });

  it('offers nothing when TWO components match — a coin flip is not a repair', () => {
    // The false-positive guard. Two objects that were both `Gripper` in the CAD
    // are indistinguishable by name; picking one would silently rewire a machine.
    const lookup = findRepairCandidate(MOVED, [
      slot('Cell/Left/Gripper'),
      slot('Cell/Right/Gripper'),
    ]);
    expect(lookup).toEqual({ found: false, reason: 'ambiguous' });
  });

  it('does NOT reach across a dedup suffix', () => {
    // The false-negative side of the same coin, and the accepted cost: the user
    // gets an orphan and re-links by hand instead of a plausible wrong guess.
    expect(findRepairCandidate(MOVED, [slot('Cell/Machine/Gripper_1')]))
      .toEqual({ found: false, reason: 'no-candidate' });
  });

  it('refuses a LEGACY mapping that never stored a component type', () => {
    // Two thirds of a key matches plenty of wrong things across a line of
    // identical stations. plan-425 chose the honest orphan over the guess.
    const legacy = { slot: SLOT, componentPath: 'Cell/OldGroup/Gripper' };
    expect(findRepairCandidate(legacy, [slot('Cell/Machine/Gripper')]))
      .toEqual({ found: false, reason: 'no-component-type' });
  });

  it('will not match a component of a DIFFERENT type with the same name', () => {
    expect(findRepairCandidate(MOVED, [slot('Cell/Machine/Gripper', 'Drive_Cylinder')]))
      .toEqual({ found: false, reason: 'no-candidate' });
  });

  it('will not match a different slot on the right component', () => {
    expect(findRepairCandidate(MOVED, [
      { slot: 'Backward', componentPath: 'Cell/Machine/Gripper', componentType: 'Drive_Simple' },
    ])).toEqual({ found: false, reason: 'no-candidate' });
  });
});
