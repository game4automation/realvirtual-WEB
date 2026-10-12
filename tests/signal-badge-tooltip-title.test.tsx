// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-badge-tooltip-title — the SignalBadge chip never carries a native
 * `title` while it is the child of the MUI <Tooltip> (plan-498 Nachkorrektur).
 *
 * MUI logs "You have provided a `title` prop to the child of <Tooltip />" on
 * EVERY render in dev mode; a badge re-renders per value change, so a hierarchy
 * with many signals produced hundreds of console errors. The rich tooltip
 * already carries the text; the chip keeps the full label as `aria-label`.
 * A chip without a tooltip (no store → not forceable) keeps its native `title`.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { SignalBadge } from '../src/core/hmi/rv-signal-badge';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { RVViewer } from '../src/core/rv-viewer';

const NAME = 'Line.Conveyor.SpeedSetpoint';

function makeViewer(): { viewer: RVViewer; store: SignalStore } {
  const store = new SignalStore();
  store.register(NAME, 'Line/Signals/Speed', 0, 'PLCOutputFloat');
  const viewer = {
    signalStore: store,
    signalBindingManager: { getLinksForSource: vi.fn(() => new Map()) },
    registry: {
      getComponentsForSignal: vi.fn(() => []),
      getComponentTypes: vi.fn(() => []),
    },
  } as unknown as RVViewer;
  return { viewer, store };
}

function tooltipTitleWarnings(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter((args: unknown[]) =>
    args.some((a: unknown) => typeof a === 'string' && a.includes('provided a `title` prop to the child of <Tooltip />')));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SignalBadge inside the MUI Tooltip', () => {
  it('renders and re-renders on value changes without the MUI title warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { viewer, store } = makeViewer();
    const view = (value: number) => (
      <SignalBadge viewer={viewer} signalName={NAME} direction="output" plcType="PLCOutputFloat" raw={value} />
    );
    const { container, rerender } = render(view(0));
    for (let i = 1; i <= 5; i++) {
      act(() => { store.set(NAME, i); });
      rerender(view(i));
    }
    expect(tooltipTitleWarnings(spy)).toHaveLength(0);

    const chip = container.querySelector('.MuiChip-root') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.hasAttribute('title'), 'the tooltip child must not carry a native title').toBe(false);
    expect(chip.getAttribute('aria-label')).toContain(NAME);
  });

  it('keeps the native title on a chip that has no tooltip', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <SignalBadge signalName={NAME} direction="output" plcType="PLCOutputFloat" raw={3} />,
    );
    const chip = container.querySelector('.MuiChip-root') as HTMLElement;
    expect(chip.getAttribute('title')).toContain(NAME);
    expect(chip.getAttribute('aria-label')).toContain(NAME);
    expect(tooltipTitleWarnings(spy)).toHaveLength(0);
  });
});
