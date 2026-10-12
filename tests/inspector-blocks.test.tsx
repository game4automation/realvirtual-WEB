// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-510 §9.2 — the Inspector building blocks next to `InspectorRow`
 * (`rv-inspector-blocks.tsx`), in real Chromium so the grid resolves:
 *  - `InspectorActionRow` buttons start on the SAME x as an `InspectorRow` field;
 *  - `DetailsDisclosure` is closed by default, opens by click / Enter / Space;
 *  - `InspectorSubheader` is uppercase at `FS.micro`;
 *  - the component-section action row after wrapping it: one dispatch per
 *    click, the disabled reason as tooltip, the command data attributes intact;
 *  - plan-514 §9.4: the `InspectorSectionMenu` contract (order, divider, red
 *    danger item under `rvDarkTheme`, Escape returns focus to ⋮).
 */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { Button, CssBaseline } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { InspectorRow } from '../src/core/hmi/rv-inspector-row';
import { InspectorActionRow, InspectorSectionMenu, InspectorSubheader, DetailsDisclosure } from '../src/core/hmi/rv-inspector-blocks';
import { ERROR, FS } from '../src/core/hmi/shared-sx';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { ComponentSection } from '../src/core/hmi/rv-component-section';
import { commandRegistry, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import { componentActionRegistry } from '../src/core/hmi/rv-component-action-registry';

afterEach(() => cleanup());

describe('InspectorActionRow', () => {
  it('its buttons start on the same x as the field of an InspectorRow (one value edge)', () => {
    render(
      <div style={{ width: 320 }}>
        <InspectorRow label="Speed">
          <input data-testid="field" style={{ width: '100%' }} />
        </InspectorRow>
        <InspectorActionRow>
          <Button data-testid="btn">Stop</Button>
          <Button>Re-provision</Button>
        </InspectorActionRow>
      </div>,
    );
    const fieldCell = screen.getByTestId('field').parentElement as HTMLElement;
    const fieldLeft = fieldCell.getBoundingClientRect().left;
    const btnLeft = screen.getByTestId('btn').getBoundingClientRect().left;
    expect(Math.abs(btnLeft - fieldLeft)).toBeLessThanOrEqual(1);
  });

  it('the same edge holds at a wider inspector', () => {
    render(
      <div style={{ width: 560 }}>
        <InspectorRow label="A much longer label than usual">
          <input data-testid="field" />
        </InspectorRow>
        <InspectorActionRow>
          <Button data-testid="btn">Jog −</Button>
        </InspectorActionRow>
      </div>,
    );
    const fieldLeft = (screen.getByTestId('field').parentElement as HTMLElement).getBoundingClientRect().left;
    expect(Math.abs(screen.getByTestId('btn').getBoundingClientRect().left - fieldLeft)).toBeLessThanOrEqual(1);
  });
});

describe('DetailsDisclosure', () => {
  it('is closed by default (aria-expanded=false, children absent); click opens and closes', () => {
    render(
      <DetailsDisclosure title="Package details" summary="BouncingBall · 188.5 kB">
        <div data-testid="detail">GUID</div>
      </DetailsDisclosure>,
    );
    const header = screen.getByRole('button', { name: /Package details/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.getByText('BouncingBall · 188.5 kB')).toBeTruthy();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('detail')).toBeTruthy();
    fireEvent.click(header);
    expect(screen.queryByTestId('detail')).toBeNull();
  });

  it('Enter and Space toggle it', () => {
    render(
      <DetailsDisclosure title="Details">
        <div data-testid="detail">x</div>
      </DetailsDisclosure>,
    );
    const header = screen.getByRole('button', { name: /Details/ });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(screen.getByTestId('detail')).toBeTruthy();
    fireEvent.keyDown(header, { key: ' ' });
    expect(screen.queryByTestId('detail')).toBeNull();
  });

  it('defaultOpen shows the children at once', () => {
    render(<DetailsDisclosure title="Open" defaultOpen><div data-testid="detail">x</div></DetailsDisclosure>);
    expect(screen.getByTestId('detail')).toBeTruthy();
  });
});

describe('InspectorSubheader', () => {
  it('renders uppercase at FS.micro', () => {
    render(<InspectorSubheader>Parameters</InspectorSubheader>);
    const el = screen.getByText('Parameters');
    const cs = getComputedStyle(el);
    expect(cs.textTransform).toBe('uppercase');
    expect(cs.fontSize).toBe(`${FS.micro}px`);
  });

  it('an accent tints the heading', () => {
    render(<InspectorSubheader accent="#66bb6a">Runtime</InspectorSubheader>);
    expect(getComputedStyle(screen.getByText('Runtime')).color).toBe('rgb(102, 187, 106)');
  });
});

// ─── Component actions after wrapping them in InspectorActionRow ─────────

describe('ComponentSection actions inside InspectorActionRow (regression)', () => {
  const runs: unknown[] = [];

  beforeAll(() => {
    const ok: CommandImpl<Record<string, never>, void> = {
      enabled: () => true,
      run: (_ctx, args) => { runs.push(args); },
    };
    const blocked: CommandImpl<Record<string, never>, void> = {
      enabled: () => ({ reason: 'Blocked for the test' }),
      run: () => { throw new Error('must not run'); },
    };
    for (const [id, impl] of [['test510.ok', ok], ['test510.blocked', blocked]] as const) {
      commandRegistry.register({
        id, label: id, readOnly: true, scope: 'none', available: true, unavailableReason: '',
        argsSchema: {}, impl: async () => impl, eagerImpl: impl,
      });
    }
    componentActionRegistry.register('Test510', [
      { id: 'go', label: 'Go', order: 1, command: { id: 'test510.ok', args: () => ({}) }, onClick: () => {} },
      { id: 'no', label: 'Nope', order: 2, command: { id: 'test510.blocked', args: () => ({}) }, onClick: () => {} },
    ]);
  });

  function mountSection() {
    const node = new Object3D();
    node.name = 'Thing';
    const viewer = {
      registry: { getNode: () => node, getPathForNode: () => 'Cell/Thing' },
      signalStore: null,
      on: () => () => {},
    } as unknown as RVViewer;
    return render(
      <div style={{ width: 320 }}>
        <ComponentSection
          nodePath="Cell/Thing" componentType="Test510" data={{}}
          overriddenFields={new Set()} consumedOnly={false}
          onFieldEdit={() => {}} onFieldReset={() => {}} onResetComponent={() => {}}
          viewer={viewer} signalStore={null}
        />
      </div>,
    );
  }

  it('a click dispatches exactly once; the command data attributes are on the button', async () => {
    runs.length = 0;
    mountSection();
    const go = await screen.findByRole('button', { name: 'Go' });
    expect(go.closest('[data-testid="rv-component-actions"]')).not.toBeNull();
    expect(go.getAttribute('data-rv-command-id')).toBe('test510.ok');
    const spy = vi.spyOn(commandRegistry, 'execute');
    fireEvent.click(go);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('test510.ok');
    spy.mockRestore();
    await waitFor(() => expect(runs).toHaveLength(1));
  });

  it('a disabled command shows its reason as tooltip', async () => {
    mountSection();
    const nope = await screen.findByRole('button', { name: 'Nope' });
    await waitFor(() => expect((nope as HTMLButtonElement).disabled).toBe(true));
    expect(nope.getAttribute('data-rv-command-id')).toBe('test510.blocked');
    fireEvent.mouseOver(nope.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Blocked for the test');
  });
});

// ─── InspectorSectionMenu contract (plan-514 §9.4) ──────────────────────

/** `#rrggbb` → the `rgb(r, g, b)` string getComputedStyle reports. */
function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('InspectorSectionMenu — the ⋮ menu contract (plan-514)', () => {
  const clicked: string[] = [];

  beforeAll(() => {
    // Registered deliberately danger-first: the MENU orders normal before danger.
    componentActionRegistry.register('Test514Menu', [
      { id: 'remove', label: 'Remove', placement: 'menu', danger: true, order: 1, onClick: () => { clicked.push('remove'); } },
      { id: 'replace', label: 'Replace…', placement: 'menu', order: 2, onClick: () => { clicked.push('replace'); } },
      { id: 'reimport', label: 'Re-import…', placement: 'menu', order: 3, onClick: () => { clicked.push('reimport'); } },
    ]);
    componentActionRegistry.register('Test514Hidden', [
      { id: 'never', label: 'Never', placement: 'menu', danger: true, visible: () => false, onClick: () => {} },
    ]);
  });

  function mountMenuSection(componentType: string) {
    const node = new Object3D();
    node.name = 'Thing';
    const viewer = {
      registry: { getNode: () => node, getPathForNode: () => 'Cell/Thing' },
      signalStore: null,
      on: () => () => {},
    } as unknown as RVViewer;
    return render(
      <ThemeProvider theme={rvDarkTheme}>
        <CssBaseline />
        <div style={{ width: 320 }}>
          <ComponentSection
            nodePath="Cell/Thing" componentType={componentType} data={{}}
            overriddenFields={new Set()} consumedOnly={false}
            onFieldEdit={() => {}} onFieldReset={() => {}} onResetComponent={() => {}}
            viewer={viewer} signalStore={null}
          />
        </div>
      </ThemeProvider>,
    );
  }

  it('the ⋮ button names the component and announces a menu', () => {
    mountMenuSection('Test514Menu');
    const btn = screen.getByTestId('rv-component-menu');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-label')).toBe('Test514Menu actions');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('normal items first, a divider, the danger item last and red; Escape returns focus to ⋮', async () => {
    mountMenuSection('Test514Menu');
    const btn = screen.getByTestId('rv-component-menu');
    await userEvent.click(btn);
    const menu = await screen.findByRole('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    const items = [...menu.querySelectorAll('[data-testid^="rv-component-menu-item-"]')] as HTMLElement[];
    expect(items.map((i) => i.dataset.testid)).toEqual([
      'rv-component-menu-item-replace',
      'rv-component-menu-item-reimport',
      'rv-component-menu-item-remove',
    ]);
    // Exactly one divider, directly between the last normal item and the danger item.
    const dividers = menu.querySelectorAll('.MuiDivider-root');
    expect(dividers).toHaveLength(1);
    expect(items[1].nextElementSibling).toBe(dividers[0]);
    expect(dividers[0].nextElementSibling).toBe(items[2]);
    expect(getComputedStyle(items[2]).color).toBe(rgbOf(ERROR));
    expect(getComputedStyle(items[0]).color).not.toBe(rgbOf(ERROR));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(btn));
    expect(clicked).toEqual([]);
  });

  it('a click on an item runs its action once and closes the menu', async () => {
    clicked.length = 0;
    mountMenuSection('Test514Menu');
    await userEvent.click(screen.getByTestId('rv-component-menu'));
    await userEvent.click(await screen.findByTestId('rv-component-menu-item-replace'));
    expect(clicked).toEqual(['replace']);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('defaultOpen (reference gallery) opens the menu on mount', async () => {
    const node = new Object3D();
    const ctx = { node, nodePath: 'Cell/Thing', viewer: {} as RVViewer, componentData: {}, componentType: 'Test514Menu' };
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <InspectorSectionMenu actions={componentActionRegistry.get('Test514Menu')} ctx={ctx} onAfterClick={() => {}} defaultOpen />
      </ThemeProvider>,
    );
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.getByTestId('rv-component-menu').getAttribute('aria-expanded')).toBe('true');
  });

  it('no visible menu action → no ⋮ button at all', () => {
    mountMenuSection('Test514Hidden');
    expect(screen.queryByTestId('rv-component-menu')).toBeNull();
  });
});
