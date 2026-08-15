// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-chip-width — the name uses the width it has (plan-422 F4, test 9.4).
 *
 * The old chip cut every name at 24 characters before CSS ever saw it, which
 * is a guess about width made in the wrong unit. In the link popover — a column
 * with room for the whole thing — the guess was simply wrong, and the user got
 * "Robo…" and "PLC_ExitCon…" back from a panel that had space to spare.
 *
 * What replaces it has to hold two properties at once, and the second is the
 * reason the fix is not just "delete the truncation": the NAME may be elided,
 * the READING may not. A single `text-overflow: ellipsis` over the whole label
 * would eat the value — the one part of a signal chip nobody can reconstruct.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { buildChipLabel, buildChipLabelParts, SignalBadge } from '../src/core/hmi/rv-signal-badge';

afterEach(cleanup);

const LONG = 'PLC_ExitConveyorRunFeedbackSignal';   // 33 chars, well past the old 24

describe('buildChipLabel — no character cap', () => {
  it('keeps a 33-character name whole in every naming variant', () => {
    for (const variant of ['full', 'standard'] as const) {
      const label = buildChipLabel(variant, {
        displayName: LONG, direction: 'output', plcType: 'PLCOutputBool', valueStr: '●',
      });
      expect(label, `${variant} truncated the name`).toContain(LONG);
      expect(label).not.toContain('…');
    }
  });

  it('falls back to the store key, also uncut', () => {
    const label = buildChipLabel('standard', {
      signalName: LONG, direction: 'input', valueStr: '○',
    });
    expect(label).toContain(LONG);
  });

  it('still ends in the reading, so the value is never the part that is lost', () => {
    expect(buildChipLabel('full', {
      displayName: LONG, direction: 'output', plcType: 'PLCOutputFloat', valueStr: '42.5',
    })).toBe(`${LONG}  OutFloat 42.5`);
  });
});

describe('buildChipLabelParts — the split that lets CSS do the cutting', () => {
  it('separates the elidable name from the fixed reading', () => {
    expect(buildChipLabelParts('full', {
      displayName: LONG, direction: 'output', plcType: 'PLCOutputBool', valueStr: '●',
    })).toEqual({ name: LONG, tail: 'OutBool ●' });

    expect(buildChipLabelParts('standard', {
      displayName: LONG, direction: 'output', valueStr: '●',
    })).toEqual({ name: LONG, tail: '●' });
  });

  it('has no name part in the minimal variant — there is nothing to elide', () => {
    expect(buildChipLabelParts('minimal', { displayName: LONG, direction: 'input', valueStr: '7' }))
      .toEqual({ tail: 'I 7' });
  });

  it('degrades to the reading alone when there is no name at all', () => {
    expect(buildChipLabelParts('full', { direction: 'output', valueStr: '●' }))
      .toEqual({ tail: 'Out ●' });
  });
});

describe('the rendered chip', () => {
  it('renders the full name in the DOM and carries it in `title`', () => {
    const { container } = render(
      <SignalBadge signalName={LONG} direction="output" plcType="PLCOutputBool" raw />,
    );
    // The name text is present in full — no ellipsis character was inserted.
    expect(container.textContent).toContain(LONG);
    expect(container.textContent).not.toContain('…');

    const chip = container.querySelector('[title]');
    expect(chip, 'chip has no title attribute').toBeTruthy();
    expect(chip!.getAttribute('title')).toContain(LONG);
  });

  it('elides the name in CSS, and only the name', () => {
    const { container } = render(
      <SignalBadge signalName={LONG} direction="output" plcType="PLCOutputBool" raw />,
    );
    const spans = [...container.querySelectorAll('span')];
    const nameSpan = spans.find((s) => s.textContent === LONG);
    expect(nameSpan, 'the name is not its own element, so it cannot elide alone').toBeTruthy();
    expect(getComputedStyle(nameSpan!).textOverflow).toBe('ellipsis');

    const tailSpan = spans.find((s) => s.textContent === 'OutBool ●');
    expect(tailSpan, 'the reading is not its own element').toBeTruthy();
    // The reading must refuse to shrink — that is what protects it from the cut.
    expect(getComputedStyle(tailSpan!).flexShrink).toBe('0');
  });

  it('shows the whole reading even when the name has no room', () => {
    const { container } = render(
      <div style={{ width: 60, display: 'flex' }}>
        <SignalBadge signalName={LONG} direction="output" plcType="PLCOutputBool" raw />
      </div>,
    );
    expect(screen.getByText('OutBool ●')).toBeTruthy();
  });
});
