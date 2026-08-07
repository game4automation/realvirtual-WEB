// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-341 §9.9 — the slot status token.
 *
 * Liveness and authority used to render as TWO elements in the same green
 * with a tooltip on only one of them. They are now exactly ONE token per
 * BOUND row with exactly ONE tooltip, resolved by the priority matrix in
 * §2.8 (c) — first matching rule wins.
 *
 * Asserted here: one concrete token per level 1-8, `remoteOwned` beats
 * `forced`, `live` swallows `bound` (level 6) while `live · local` (level 7)
 * makes the deviation visible.
 *
 * Also asserted: WHICH levels need a binding. The liveness levels do — they
 * describe an active binding. The write locks `forced` and `remote` do NOT: they
 * exist without any binding (plan-320), and an invisible pin is exactly the bug
 * this distinction prevents. Negative cases: an `unavailable` row and an unbound
 * row WITHOUT a lock carry no token at all.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  SignalSlotRow,
  resolveSlotStatusToken,
  type SlotRow,
} from '../src/core/hmi/rv-signal-slot-row';

afterEach(cleanup);

const BOUND = { signal: 'Conveyor.Start', interfaceId: 'connect-1' } as SlotRow['mapping'];

function row(overrides: Partial<SlotRow> = {}): SlotRow {
  return {
    kind: 'mapped-signal',
    componentPath: '.',
    slot: 'Forward',
    type: 'bool',
    direction: 'plcOutput',
    targetName: 'Conveyor.Forward',
    mapping: BOUND,
    ...overrides,
  };
}

/** Every status token currently rendered in the document. */
function tokens(): HTMLElement[] {
  return screen.queryAllByTestId(/^slot-status-/);
}

describe('status token — priority matrix §2.8 (c)', () => {
  const cases: [number, string, Partial<SlotRow>][] = [
    [1, 'conflict', { liveness: 'conflict', authority: 'bound' }],
    [2, 'remote', { liveness: 'live', authority: 'bound', remoteOwned: true }],
    [3, 'forced', { liveness: 'live', authority: 'forced' }],
    [4, 'disconnected', { liveness: 'disconnected', authority: 'bound' }],
    [5, 'pending', { liveness: 'pending', authority: 'bound' }],
    [6, 'live · hold', { liveness: 'hold', authority: 'bound' }],
    [7, 'live · local', { liveness: 'live', authority: 'component' }],
    [8, 'bound', { authority: 'bound' }],
  ];

  for (const [level, label, overrides] of cases) {
    it(`level ${level} renders exactly one token labelled "${label}"`, () => {
      render(<SignalSlotRow row={row(overrides)} />);
      const found = tokens();
      expect(found).toHaveLength(1);
      expect(found[0].textContent).toBe(label);
      expect(found[0].getAttribute('data-rv-status-level')).toBe(String(level));
      // Never colour alone — the token always carries an icon next to the label.
      expect(found[0].querySelector('svg')).not.toBeNull();
    });
  }

  it('a plainly LIVE binding renders no token at all (User decision 30.07.)', () => {
    // Both chips of the row show their live value; the word only restated them
    // and cost the width the two signal names need. `hold` is the exception —
    // "frozen" is exactly what a value cannot show by itself.
    render(<SignalSlotRow row={row({ liveness: 'live', authority: 'bound' })} />);
    expect(tokens()).toHaveLength(0);
    expect(resolveSlotStatusToken(row({ liveness: 'live', authority: 'bound' }), true)).toBeNull();
  });

  it('remoteOwned BEATS forced', () => {
    const t = resolveSlotStatusToken(
      row({ liveness: 'live', authority: 'forced', remoteOwned: true }), true,
    );
    expect(t?.level).toBe(2);
    expect(t?.label).toBe('remote');
  });

  it('conflict beats everything below it', () => {
    const t = resolveSlotStatusToken(
      row({ liveness: 'conflict', authority: 'forced', remoteOwned: true }), true,
    );
    expect(t?.level).toBe(1);
    expect(t?.label).toBe('conflict');
  });

  it('"live" SWALLOWS "bound" — authority is named only when it deviates', () => {
    // Nothing at all for a plainly live binding: the liveness itself is silent
    // now, and it still does not let "bound" through underneath it.
    expect(resolveSlotStatusToken(row({ liveness: 'live', authority: 'bound' }), true)).toBeNull();

    // ...and the deviation resurfaces when the local simulation, not the binding, writes.
    const local = resolveSlotStatusToken(row({ liveness: 'live', authority: 'component' }), true);
    expect(local?.level).toBe(7);
    expect(local?.label).toBe('live · local');
  });
});

describe('status token — one element, one tooltip', () => {
  it('renders a single token with a single tooltip, not two adjacent labels', () => {
    // `hold` stands in for the former `live` case here: it is the level that
    // still renders, and it is where liveness and authority used to double up.
    render(<SignalSlotRow row={row({ liveness: 'hold', authority: 'bound' })} />);
    const found = tokens();
    expect(found).toHaveLength(1);
    // The old pair of elements is gone for good.
    expect(screen.queryAllByTestId(/^slot-liveness-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^slot-authority-/)).toHaveLength(0);
    // Exactly one tooltip trigger wraps the token.
    expect(found[0].getAttribute('aria-label') ?? found[0].title ?? '').toBeDefined();
    expect(resolveSlotStatusToken(row({ liveness: 'hold', authority: 'bound' }), true)?.tooltip)
      .toBeTruthy();
  });

  it('uses neither red nor green — warnings differ by icon and label only', () => {
    const warn = [1, 2, 3, 4].map((level) => {
      const overrides: Partial<SlotRow>[] = [
        { liveness: 'conflict' },
        { liveness: 'live', authority: 'bound', remoteOwned: true },
        { authority: 'forced' },
        { liveness: 'disconnected' },
      ];
      return resolveSlotStatusToken(row(overrides[level - 1]), true)!;
    });
    // All four warning levels share ONE amber (red means "PLC input TRUE",
    // green means "PLCOutput" — neither may appear here).
    expect(new Set(warn.map((t) => t.color)).size).toBe(1);
    for (const t of warn) {
      expect(t.color.toLowerCase()).not.toBe('#ef5350');
      expect(t.color.toLowerCase()).not.toBe('#66bb6a');
    }
    // ...and it is the DESIGN.md system amber, not a token-local special. At
    // the 3:1 bar the value palette is held to (SC 1.4.11, User decision
    // 29.07.) #ffa726 reaches 4.15:1 on the #505050 worst case, so the lighter
    // shade the old 4.5:1 target forced is no longer needed.
    expect(warn[0].color.toLowerCase()).toBe('#ffa726');
    // ...but every level is still distinguishable without colour.
    expect(new Set(warn.map((t) => t.label)).size).toBe(4);
    expect(new Set(warn.map((t) => t.icon)).size).toBe(4);
  });
});

describe('status token — write locks survive without a binding', () => {
  /** An unbound row: no mapping, but the GLB assignment (targetName) is there. */
  function unbound(overrides: Partial<SlotRow> = {}): SlotRow {
    return row({ mapping: undefined, ...overrides });
  }

  it('shows "forced" on an UNBOUND row — a force needs no binding', () => {
    render(<SignalSlotRow row={unbound({ authority: 'forced', authorityReason: 'authority-forced' })} />);
    const found = tokens();
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toBe('forced');
    expect(found[0].getAttribute('data-rv-status-level')).toBe('3');
  });

  it('shows "remote" on an UNBOUND row — a remote owner pre-empts local writers', () => {
    render(<SignalSlotRow row={unbound({ authority: 'component', remoteOwned: true })} />);
    const found = tokens();
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toBe('remote');
    expect(found[0].getAttribute('data-rv-status-level')).toBe('2');
  });

  it('stays silent on an UNBOUND row with neither lock', () => {
    render(<SignalSlotRow row={unbound({ authority: 'component' })} />);
    expect(tokens()).toHaveLength(0);
  });

  it('never shows a LIVENESS level without a binding', () => {
    // Liveness describes an active binding; unbound + a stale liveness value
    // must not resurrect "live"/"pending"/"disconnected"/"conflict" — nor the
    // bare "bound" fallback.
    for (const liveness of ['conflict', 'disconnected', 'pending', 'live', 'hold'] as const) {
      expect(resolveSlotStatusToken(unbound({ liveness }), false)).toBeNull();
    }
    expect(resolveSlotStatusToken(unbound({ authority: 'bound' }), false)).toBeNull();
  });

  it('an UNAVAILABLE row carries no token even when forced', () => {
    expect(resolveSlotStatusToken(
      unbound({ kind: 'unavailable', reason: 'no model signal', authority: 'forced' }), false,
    )).toBeNull();
  });
});

describe('status token — negative cases', () => {
  it('an UNBOUND row carries no token at all', () => {
    render(
      <SignalSlotRow
        row={row({ mapping: undefined, targetName: undefined, authority: 'component' })}
      />,
    );
    expect(tokens()).toHaveLength(0);
    expect(screen.getByText('– not linked')).toBeTruthy();
    expect(resolveSlotStatusToken(row({ mapping: undefined }), false)).toBeNull();
  });

  it('an UNAVAILABLE row carries no token at all', () => {
    render(
      <SignalSlotRow
        row={row({ kind: 'unavailable', reason: 'no model signal', mapping: undefined })}
      />,
    );
    expect(tokens()).toHaveLength(0);
    expect(screen.getByTestId('slot-row-unavailable-Forward')).toBeTruthy();
    expect(
      resolveSlotStatusToken(row({ kind: 'unavailable', liveness: 'live' }), true),
    ).toBeNull();
  });
});
