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

function makeViewer(
  linkCount = 1,
  withReference = true,
  // plan-353 F2: a real binding carries the display pair; the fallback cases
  // (no type, no label) get their own tests below.
  display: { componentType?: string; label?: string } = { componentType: 'Conveyor', label: 'Forward' },
): ViewerFixture {
  const store = new SignalStore();
  store.register(SIGNAL_NAME, 'Line/Signals/Start', false, 'PLCOutputBool');
  const links = Array.from({ length: linkCount }, (_, index) => ({
    path: `DemoCell/Conveyor${index}`,
    slot: `Forward${index}`,
    placedId: `placed-${index}`,
    ...(display.componentType !== undefined ? { componentType: display.componentType } : {}),
    ...(display.label !== undefined ? { label: `${display.label}${index}` } : {}),
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

/** The provenance block title since plan-353 F4 (was the ambiguous "Drives"). */
const DRIVES_TITLE = 'Drives these slots';

async function openTooltip(container: HTMLElement): Promise<void> {
  const chip = container.querySelector('.MuiChip-root');
  expect(chip).toBeTruthy();
  fireEvent.mouseOver(chip!);
  await screen.findByText(DRIVES_TITLE);
}

afterEach(() => {
  cleanup();
  resetSlotAuthority();
  setTooltipField('binding', true);
});

describe('SignalBadge tooltip provenance', () => {
  it('resolves lazily and tells the two provenance blocks apart while rendering authority', async () => {
    const { viewer, getLinksForSource } = makeViewer();
    const slotId = makeSlotId('placed-0', '.', 'Conveyor', 'Forward0');
    registerSlotChannel(slotId, makeSignalChannelId(SIGNAL_NAME));
    claimBound(slotId);

    const { container } = renderBadge(viewer);
    expect(getLinksForSource).not.toHaveBeenCalled();

    await openTooltip(container);

    expect(getLinksForSource).toHaveBeenCalledOnce();
    // F4: the two blocks no longer share a word. "Drives these slots" is what
    // this signal WRITES; "Referenced by" is what points AT it (same term the
    // property inspector's footer uses for the same relation).
    expect(screen.getByText(DRIVES_TITLE)).toBeTruthy();
    expect(screen.getByText('Referenced by')).toBeTruthy();
    // F2: display pair from the binding — technical type name, label SSOT.
    expect(screen.getByText('Conveyor · Forward0')).toBeTruthy();
    // …and the node stays visible as the dim qualifier (§3.1).
    expect(screen.getByText('Conveyor0')).toBeTruthy();
    expect(screen.getByText('WebSensor · DemoCell/Sensor1')).toBeTruthy();
    // The note is the SHORT form of the slot-row tooltip's sentence — asserted
    // through the shared vocabulary so the two can never drift apart again.
    expect(screen.getByTestId('signal-authority-note').textContent).toBe(AUTHORITY_SENTENCE.bound);
  });

  it('falls back to the bare label when the binding carries no componentType (F2)', async () => {
    // No invented "Component ·" prefix — the row states only what is known.
    const { viewer } = makeViewer(1, false, { label: 'Forward' });
    const { container } = renderBadge(viewer);

    await openTooltip(container);

    expect(screen.getByText('Forward0')).toBeTruthy();
    expect(screen.queryByText(/Component ·/)).toBeNull();
  });

  it('falls back to the raw slot name when the binding carries no label (F2)', async () => {
    const { viewer } = makeViewer(1, false, { componentType: 'Drive_Simple' });
    const { container } = renderBadge(viewer);

    await openTooltip(container);

    expect(screen.getByText('Drive_Simple · Forward0')).toBeTruthy();
  });

  it('keeps the driven-slots block visible when the decorative binding field is disabled', async () => {
    setTooltipField('binding', false);
    const { viewer } = makeViewer();
    const { container } = renderBadge(viewer);

    await openTooltip(container);

    expect(screen.getByText(DRIVES_TITLE)).toBeTruthy();
    expect(screen.getByText('Conveyor · Forward0')).toBeTruthy();
    expect(screen.queryByText('Referenced by')).toBeNull();
  });

  it('caps the driven-slots block at MAX_TOOLTIP_BINDING_ROWS', async () => {
    const extraRows = 3;
    const { viewer } = makeViewer(MAX_TOOLTIP_BINDING_ROWS + extraRows, false);
    const { container } = renderBadge(viewer);

    await openTooltip(container);

    // Rows share a componentType, so the NODE qualifier is what keeps them
    // apart — assert on it, otherwise the cap test would pass on duplicates.
    expect(screen.getByText(`Conveyor${MAX_TOOLTIP_BINDING_ROWS - 1}`)).toBeTruthy();
    expect(screen.queryByText(`Conveyor${MAX_TOOLTIP_BINDING_ROWS}`)).toBeNull();
    expect(screen.getByText(`+${extraRows} more`)).toBeTruthy();
  });

  it('renders the activity label as line 2, under the name (plan-353 F5)', async () => {
    // The label was computed and carried in the model since plan-234 but never
    // rendered — a dead display field. This asserts the RENDER, not the model:
    // it must be present, carry the liveness word, and sit directly under the
    // signal name (position is the requirement, not just existence).
    const { viewer } = makeViewer(1, false);
    const { container } = renderBadge(viewer);

    await openTooltip(container);

    const activity = screen.getByTestId('signal-activity-label');
    expect(activity).toBeTruthy();
    // Which word appears depends on the viewer mode (a never-written signal is
    // 'local' standalone, 'no source' when an interface is expected), so the
    // assert pins the VOCABULARY rather than one mode's answer.
    expect(['live', 'supplied', 'local', 'stale', 'no source'])
      .toContain(activity.textContent?.replace(/ \d+s$/, ''));

    // Position: the element right before it is the (clickable) name line.
    const previous = activity.previousElementSibling;
    expect(previous?.textContent).toBe(SIGNAL_NAME);
  });
});
