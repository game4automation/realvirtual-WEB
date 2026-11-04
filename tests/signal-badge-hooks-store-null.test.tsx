// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Regression for a model-clear crash (field report) caused by SignalBadge skipping a hook. */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBadge } from '../src/core/hmi/rv-signal-badge';
import { rvDarkTheme } from '../src/core/hmi/theme';
import type { RVViewer } from '../src/core/rv-viewer';

const NAME = 'Line.Conveyor.Running';

function viewerWith(store: SignalStore | null): RVViewer {
  return {
    signalStore: store,
    signalBindingManager: undefined,
    registry: null,
  } as unknown as RVViewer;
}

function badge(viewer: RVViewer) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <SignalBadge
        viewer={viewer}
        signalName={NAME}
        direction="output"
        plcType="PLCOutputBool"
        raw={true}
      />
    </ThemeProvider>
  );
}

afterEach(cleanup);

describe('SignalBadge hook order across model clear', () => {
  it('survives enabled -> disabled -> enabled while keeping the chip rendered', () => {
    const store = new SignalStore();
    store.register(NAME, 'Line/Signals/Running', true, 'PLCOutputBool');
    const enabledViewer = viewerWith(store);
    const disabledViewer = viewerWith(null);
    const { container, rerender } = render(badge(enabledViewer));

    expect(container.querySelector('.MuiChip-root')).not.toBeNull();
    expect(() => rerender(badge(disabledViewer))).not.toThrow();
    expect(container.querySelector('.MuiChip-root')).not.toBeNull();
    expect(() => rerender(badge(enabledViewer))).not.toThrow();
    expect(container.querySelector('.MuiChip-root')).not.toBeNull();
  });
});
