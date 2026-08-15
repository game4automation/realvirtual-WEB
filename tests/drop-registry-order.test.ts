// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-registry-order.test.ts — plan-353 §9.1 (F1).
 *
 * Invariant 3 of plan-341 §2.3 ("the outcome is last, and the hover is already
 * gone when it arrives") used to hold only because the ANNOUNCER latched the
 * trailing `leave` away. That is a compensation at the consumer, not a
 * guarantee at the source: any other subscriber that read the DOM from its
 * `outcome` handler still saw a target painted as hovered.
 *
 * These tests pin the guarantee where it now lives — in the registry:
 *   1. the emission ORDER is `enter → leave → outcome`, and
 *   2. the OBSERVABLE state at the moment `outcome` fires carries no hover
 *      value; the entry is back on its drag BASE state.
 *
 * Both branches are checked. `clearHover()` restores the BASE state rather than
 * clearing the attribute (plan-341 §2.4 three-state machine), so the expected
 * value differs per branch and is fixed as a constant instead of asserted as
 * "not null": an accepted target is a `candidate` during the drag, a rejected
 * one was never a candidate and carries no attribute at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createDropTargetRegistry,
  type DropTransition,
} from '../src/core/hmi/drop-target-registry';

interface Payload { kind: 'bool' | 'float' }
interface Reason { why: string }

/** The two states hover can paint (drop-target-registry `updateHover`). */
const HOVER_STATES = ['valid', 'invalid'];

/**
 * The BASE state each branch falls back to when the hover is cleared:
 * `beginCandidates()` marks accepting entries `candidate` and leaves rejecting
 * ones without an attribute (`null`).
 */
const BASE_STATE_FOR: Record<'accepted' | 'rejected', string | null> = {
  accepted: 'candidate',
  rejected: null,
};

const teardown: Array<() => void> = [];
afterEach(() => { for (const fn of teardown.splice(0)) fn(); });

/** One registry with a single, really laid-out target that accepts or rejects. */
function makeTarget(branch: 'accepted' | 'rejected') {
  const registry = createDropTargetRegistry<Payload, Reason>();
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.left = '40px';
  el.style.top = '40px';
  el.style.width = '200px';
  el.style.height = '40px';
  document.body.appendChild(el);

  let dropped = false;
  const handle = registry.createDropTarget({
    reject: () => (branch === 'accepted' ? null : { why: 'type' }),
    describe: () => ({ targetId: 'row-1', accessibleLabel: 'Row 1' }),
    onDrop: () => { dropped = true; },
  });
  handle.attach(el);

  teardown.push(() => { handle.dispose(); el.remove(); });

  const rect = el.getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return { registry, el, center, wasDropped: () => dropped };
}

describe('dropAt ordering (plan-353 F1)', () => {
  it.each(['accepted', 'rejected'] as const)(
    'clears the hover state before emitting on the %s path',
    (branch) => {
      const { registry, el, center, wasDropped } = makeTarget(branch);

      const phases: string[] = [];
      let stateAtOutcome: string | null | undefined;
      let resultAtOutcome: string | undefined;
      registry.subscribe((t: DropTransition<Reason>) => {
        phases.push(t.phase);
        if (t.phase === 'outcome') {
          // The whole point: read the DOM from INSIDE the outcome handler.
          stateAtOutcome = el.getAttribute('data-rv-drop-state');
          resultAtOutcome = t.result;
        }
      });

      const payload: Payload = { kind: 'bool' };
      registry.beginCandidates(payload);
      expect(el.getAttribute('data-rv-drop-state')).toBe(BASE_STATE_FOR[branch]);

      registry.updateHover(center.x, center.y, payload);
      // Sanity: the hover really was painted, so the assert below is meaningful.
      expect(HOVER_STATES).toContain(el.getAttribute('data-rv-drop-state'));

      registry.dropAt(center.x, center.y, payload);

      expect(phases).toEqual(['enter', 'leave', 'outcome']);
      expect(resultAtOutcome).toBe(branch);
      // …the hover is gone …
      expect(HOVER_STATES).not.toContain(stateAtOutcome);
      // …and the entry sits on its drag base state again.
      expect(stateAtOutcome).toBe(BASE_STATE_FOR[branch]);
      // The reordering must not change WHETHER the drop lands.
      expect(wasDropped()).toBe(branch === 'accepted');
    },
  );

  it('still emits exactly one outcome per drag', () => {
    const { registry, center } = makeTarget('accepted');
    const outcomes: DropTransition<Reason>[] = [];
    registry.subscribe((t) => { if (t.phase === 'outcome') outcomes.push(t); });

    const payload: Payload = { kind: 'bool' };
    registry.beginCandidates(payload);
    registry.updateHover(center.x, center.y, payload);
    registry.dropAt(center.x, center.y, payload);
    // The drag store calls endDrag() after every drop; it must stay silent
    // because dropAt() already announced the outcome.
    registry.endDrag();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ result: 'accepted', targetId: 'row-1' });
  });

  it('emits outcome:none — and no leave — for a drop that hits nothing', () => {
    const { registry, center } = makeTarget('accepted');
    const phases: string[] = [];
    registry.subscribe((t) => { phases.push(t.phase); });

    const payload: Payload = { kind: 'bool' };
    registry.beginCandidates(payload);
    // Drop far away from the target, without ever hovering it.
    registry.dropAt(center.x + 800, center.y + 600, payload);
    registry.endDrag();

    expect(phases).toEqual(['outcome']);
  });
});
