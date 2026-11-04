// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { KpiBar } from '../src/core/hmi/KpiBar';

const device = vi.hoisted(() => ({ compact: false, mobile: false }));
const mounted = vi.hoisted(() => vi.fn());
vi.mock('../src/hooks/use-viewer', () => ({ useViewer: () => ({}) }));
vi.mock('../src/hooks/use-mobile-layout', () => ({
  useMobileLayout: () => device.compact,
  isMobileDevice: () => device.mobile,
}));
vi.mock('../src/hooks/use-viewport-insets', () => ({
  useViewportInsets: () => ({ top: 0, left: 0, right: 0 }),
}));
vi.mock('../src/hooks/use-slot', () => ({ useSlot: () => [{ component: () => {
  mounted();
  return <div>Machine KPI</div>;
} }] }));

afterEach(() => { cleanup(); mounted.mockClear(); device.compact = false; device.mobile = false; });

describe('KPI bar mobile visibility', () => {
  it.each([
    { compact: true, mobile: true },
    { compact: false, mobile: true },
    { compact: true, mobile: false },
  ])('does not mount KPI content for %o', (layout) => {
    Object.assign(device, layout);
    render(<KpiBar />);
    expect(screen.queryByText('Machine KPI')).toBeNull();
    expect(mounted).not.toHaveBeenCalled();
  });

  it('restores KPIs when a desktop window leaves compact layout', () => {
    device.compact = true;
    const { rerender } = render(<KpiBar />);
    device.compact = false;
    rerender(<KpiBar />);
    expect(screen.getByText('Machine KPI')).toBeTruthy();
  });
});
