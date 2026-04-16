// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { WebSensorTooltipContent, type WebSensorTooltipData } from '../src/core/hmi/tooltip/WebSensorTooltipContent';
import {
  sensorHistoryStore,
  __resetSensorHistoryStore,
} from '../src/core/hmi/sensor-history-store';
import type { RVViewer } from '../src/core/rv-viewer';

const data: WebSensorTooltipData = {
  type: 'web-sensor',
  nodePath: 'Cell/B-IGC01',
  label: 'B-IGC01',
  isInt: false,
};

// Minimal mock viewer — registry.getNode returns null, triggering the fallback
// branch in the tooltip that uses data.label/isInt directly.
function mockViewer(): RVViewer {
  return {
    registry: {
      getNode: (_path: string) => null,
    },
  } as unknown as RVViewer;
}

function wrap(ui: ReactNode) {
  return <ThemeProvider theme={rvDarkTheme}>{ui}</ThemeProvider>;
}

describe('WebSensorTooltipContent — Show button', () => {
  beforeEach(() => {
    __resetSensorHistoryStore();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('hides Show button when not pinned', () => {
    render(wrap(<WebSensorTooltipContent data={data} viewer={mockViewer()} isPinned={false} />));
    expect(screen.queryByRole('button', { name: /show history/i })).toBeNull();
  });

  it('shows Show button when pinned', () => {
    render(wrap(<WebSensorTooltipContent data={data} viewer={mockViewer()} isPinned={true} />));
    expect(screen.getByRole('button', { name: /show history/i })).toBeTruthy();
  });

  it('clicking Show opens the history store with this sensor', () => {
    const spy = vi.spyOn(sensorHistoryStore, 'open');
    render(wrap(<WebSensorTooltipContent data={data} viewer={mockViewer()} isPinned={true} />));
    fireEvent.click(screen.getByRole('button', { name: /show history/i }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      path: 'Cell/B-IGC01',
      label: 'B-IGC01',
      isInt: false,
    }));
    spy.mockRestore();
  });

  it('Show button aria-label references the sensor label', () => {
    render(wrap(<WebSensorTooltipContent data={data} viewer={mockViewer()} isPinned={true} />));
    const btn = screen.getByRole('button', { name: /show history/i });
    expect(btn.getAttribute('aria-label')).toContain('B-IGC01');
  });
});
