// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.5 — the DES Snapshot menu: Save and Load are ONE toolbar button
 * with a two-row menu, and every DES side-tool entry sits in the `analysis`
 * group.
 */

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { DESSnapshotMenu, DESHMIPlugin } from '../src/plugins/des/hmi/des-hmi-plugin';
import { TOOL_GROUP } from '../src/core/hmi/button-panel-sections';
import type { RVViewer } from '../src/core/rv-viewer';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

interface FakeCtl { snapshotJson: ReturnType<typeof vi.fn>; restoreJson: ReturnType<typeof vi.fn> }

function makeViewer(ctl: FakeCtl | null): RVViewer {
  return {
    simulationKernel: { desControl: () => ctl },
    on: () => () => {},
  } as unknown as RVViewer;
}

function mount(viewer: RVViewer) {
  const Menu = DESSnapshotMenu as unknown as (p: { viewer: RVViewer }) => ReactElement | null;
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <div style={{ position: 'fixed', left: 40, top: 80 }}><Menu viewer={viewer} /></div>
    </ThemeProvider>,
  );
}

const paper = () => document.querySelector<HTMLElement>('[data-rv-flyout-paper]');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DESSnapshotMenu', () => {
  it('renders nothing without a DES control', () => {
    mount(makeViewer(null));
    expect(screen.queryByTestId('des-side-snapshot')).toBeNull();
  });

  it('with a DES control: ONE trigger, no separate Save / Load buttons before it is opened', async () => {
    mount(makeViewer({ snapshotJson: vi.fn(), restoreJson: vi.fn() }));
    const trigger = await screen.findByTestId('des-side-snapshot');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-label')).toBe('DES snapshot');
    expect(screen.queryByTestId('des-side-snapshot-save')).toBeNull();
    expect(screen.queryByTestId('des-side-snapshot-load')).toBeNull();
    expect(document.querySelectorAll('button').length).toBe(1);
  });

  it('"Save snapshot" reads snapshotJson() and triggers a download', async () => {
    const ctl: FakeCtl = { snapshotJson: vi.fn(() => '{"t":1}'), restoreJson: vi.fn() };
    mount(makeViewer(ctl));
    fireEvent.click(await screen.findByTestId('des-side-snapshot'));
    await waitFor(() => expect(paper()).not.toBeNull());

    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rv-test/snap');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    fireEvent.click(screen.getByTestId('des-side-snapshot-save'));

    await waitFor(() => expect(ctl.snapshotJson).toHaveBeenCalledTimes(1));
    expect(downloads).toEqual(['des-snapshot.json']);
    // An action row closes the menu.
    await waitFor(() => expect(paper()).toBeNull());
  });

  it('"Load snapshot…" opens the file dialog and passes the file text to restoreJson()', async () => {
    const ctl: FakeCtl = { snapshotJson: vi.fn(), restoreJson: vi.fn() };
    mount(makeViewer(ctl));
    fireEvent.click(await screen.findByTestId('des-side-snapshot'));
    await waitFor(() => expect(paper()).not.toBeNull());

    let picker: HTMLInputElement | null = null;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      if (this.type === 'file') picker = this;
    });

    fireEvent.click(screen.getByTestId('des-side-snapshot-load'));

    await waitFor(() => expect(picker).not.toBeNull());
    expect(picker!.accept).toBe('.json');
    const file = new File(['{"restored":true}'], 'snap.json', { type: 'application/json' });
    Object.defineProperty(picker!, 'files', { value: [file] });
    await (picker!.onchange as () => Promise<void>)();
    expect(ctl.restoreJson).toHaveBeenCalledWith('{"restored":true}');
  });
});

describe('DES HMI slot declarations (plan-2010)', () => {
  it('the three remaining side tools retain their analysis group and ids', () => {
    const tools = new DESHMIPlugin().slots.filter((s) => s.slot === 'button-group');
    expect(tools.map((t) => t.visibilityId)).toEqual([
      'des-event-queue', 'des-snapshot', 'des-experiments',
    ]);
    for (const t of tools) expect(t.group).toBe(TOOL_GROUP.analysis);
    expect((tools[1].component as { name: string }).name).toBe('DESSnapshotMenu');
  });
});
