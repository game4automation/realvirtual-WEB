// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RVViewer } from '../src/core/rv-viewer';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  claimBound,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  resetSlotAuthority,
} from '../src/core/engine/rv-slot-authority';
import {
  MAX_TOOLTIP_BINDING_ROWS,
  SignalBadge,
} from '../src/core/hmi/rv-signal-badge';
import { setTooltipField } from '../src/core/hmi/signal-display-store';
import { AUTHORITY_SENTENCE } from '../src/core/hmi/signal-vocabulary';

const SIGNAL_NAME = 'Line.Start';

interface ViewerFixture {
  viewer: RVViewer;
  getLinksForSource: ReturnType<typeof vi.fn>;
}

function makeViewer(linkCount = 1, withReference = true): ViewerFixture {
  const store = new SignalStore();
  store.register(SIGNAL_NAME, 'Line/Signals/Start', false, 'PLCOutputBool');
  const links = Array.from({ length: linkCount }, (_, index) => ({
    path: `DemoCell/Conveyor${index}`,
    slot: `Forward${index}`,
    placedId: `placed-${index}`,
  }));
  const getLinksForSource = vi.fn(() => new Map([[SIGNAL_NAME, links]]));
  const viewer = {
    signalStore: store,
    signalBindingManager: { getLinksForSource },
    registry: {
      getComponentsForSignal: vi.fn(() => withReference
        ? [{ componentType: 'WebSensor', sourcePath: 'DemoCell/Sensor1', fieldName: 'SignalBool' }]
        : []),
      getComponentTypes: vi.fn(() => ['LayoutObject', 'Conveyor']),
    },
  } as unknown as RVViewer;
  return { viewer, getLinksForSource };
}

function renderBadge(viewer: RVViewer) {
  return render(
    <SignalBadge
      viewer={viewer}
      direction="output"
      plcType="PLCOutputBool"
      raw={false}
      signalName={SIGNAL_NAME}
    />,
  );
}

async function openTooltip(container: HTMLElement): Promise<void> {
  const chip = container.querySelector('.MuiChip-root');
  expect(chip).toBeTruthy();
  fireEvent.mouseOver(chip!);
  await screen.findByText('Drives');
}

afterEach(() => {
  cleanup();
  resetSlotAuthority();
  setTooltipField('binding', true);
});

describe('SignalBadge tooltip provenance', () => {
  it('resolves lazily and distinguishes Drives from Referenced by while rendering authority', async () => {
    const { viewer, getLinksForSource } = makeViewer();
    const slotId = makeSlotId('placed-0', '.', 'Conveyor', 'Forward0');
    registerSlotChannel(slotId, makeSignalChannelId(SIGNAL_NAME));
    claimBound(slotId);

    const { container } = renderBadge(viewer);
    expect(getLinksForSource).not.toHaveBeenCalled();

    await openTooltip(container);

    expect(getLinksForSource).toHaveBeenCalledOnce();
    expect(screen.getByText('Drives')).toBeTruthy();
    expect(screen.getByText('Referenced by')).toBeTruthy();
    expect(screen.getByText('Conveyor0 · Forward0')).toBeTruthy();
    expect(screen.getByText('WebSensor · DemoCell/Sensor1')).toBeTruthy();
    // The note is the SHORT form of the slot-row tooltip's sentence — asserted
    // through the shared vocabulary so the two can never drift apart again.
    expect(screen.getByTestId('signal-authority-note').textContent).toBe(AUTHORITY_SENTENCE.bound);
  });

  it('keeps Drives visible when the decorative binding field is disabled', async () => {
    setTooltipField('binding', false);
    const { viewer } = makeViewer();
    const { container } = renderBadge(viewer);

    await openTooltip(container);

    expect(screen.getByText('Drives')).toBeTruthy();
    expect(screen.getByText('Conveyor0 · Forward0')).toBeTruthy();
    expect(screen.queryByText('Referenced by')).toBeNull();
  });

  it('caps the Drives block at MAX_TOOLTIP_BINDING_ROWS', async () => {
    const extraRows = 3;
    const { viewer } = makeViewer(MAX_TOOLTIP_BINDING_ROWS + extraRows, false);
    const { container } = renderBadge(viewer);

    await openTooltip(container);

    expect(screen.getByText(`Conveyor${MAX_TOOLTIP_BINDING_ROWS - 1} · Forward${MAX_TOOLTIP_BINDING_ROWS - 1}`)).toBeTruthy();
    expect(screen.queryByText(`Conveyor${MAX_TOOLTIP_BINDING_ROWS} · Forward${MAX_TOOLTIP_BINDING_ROWS}`)).toBeNull();
    expect(screen.getByText(`+${extraRows} more`)).toBeTruthy();
  });
});
