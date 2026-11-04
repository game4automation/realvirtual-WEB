// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.2 — the floating tool toolbar renders sections with CSS
 * dividers: one wrapper per section, a line only BETWEEN non-empty sections,
 * an all-`null` section hidden, nothing at all without groups, and the line
 * turned vertical on the mobile bottom row.
 *
 * Rendered with a REAL viewer (`createTestViewer`) and dummy `button-group`
 * entries registered into its UI registry, so the slot, mode and left-window
 * hooks ButtonPanel reads are the production ones. Only the layout breakpoint
 * is mocked (a hoisted flag), the way the activity-bar suites do it.
 */

import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ButtonPanel } from '../src/core/hmi/ButtonPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { UNGROUPED_SECTION_KEY } from '../src/core/hmi/button-panel-sections';
import type { UISlotEntry } from '../src/core/rv-ui-plugin';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const layout = vi.hoisted(() => ({ mobile: false }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => layout.mobile,
}));

let handle: TestViewerHandle;
const registered: string[] = [];

beforeAll(async () => {
  handle = await createTestViewer('webgl');
}, 30_000);

afterAll(() => {
  handle?.dispose();
});

beforeEach(() => {
  layout.mobile = false;
});

afterEach(() => {
  cleanup();
  for (const id of registered.splice(0)) handle.viewer.uiRegistry.unregister(id);
});

/** A toolbar button stand-in. */
function tool(name: string) {
  const Comp = () => <button type="button" data-testid={`tool-${name}`}>{name}</button>;
  Comp.displayName = `Tool_${name}`;
  return Comp;
}

/** A slot component that renders nothing (no DES runner, no planner plugin, …). */
const Nothing = () => null;

function register(id: string, slots: Array<Omit<UISlotEntry, 'slot'>>): void {
  registered.push(id);
  act(() => {
    handle.viewer.uiRegistry.register({
      id,
      slots: slots.map((s) => ({ slot: 'button-group' as const, ...s })),
    });
  });
}

function renderPanel() {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={handle.viewer}>
        <ButtonPanel />
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

const sectionEls = () => [...document.querySelectorAll<HTMLElement>('[data-rv-tool-group]')];
const hasTopLine = (el: HTMLElement) => {
  const cs = getComputedStyle(el);
  return cs.borderTopStyle === 'solid' && parseFloat(cs.borderTopWidth) > 0;
};
const hasLeftLine = (el: HTMLElement) => {
  const cs = getComputedStyle(el);
  return cs.borderLeftStyle === 'solid' && parseFloat(cs.borderLeftWidth) > 0;
};
const isShown = (el: HTMLElement) => getComputedStyle(el).display !== 'none';

describe('ButtonPanel sections (plan-2010 §9.2)', () => {
  it('three groups → three sections, a divider on exactly the two that follow another', () => {
    register('groups-a', [
      { component: tool('undo'), order: 250, group: 'editing' },
      { component: tool('clip'), order: 65, group: 'view' },
      { component: tool('snap'), order: 200, group: 'model' },
      { component: tool('path'), order: 275, group: 'model' },
    ]);
    renderPanel();

    const sections = sectionEls();
    expect(sections.map((s) => s.dataset.rvToolGroup)).toEqual(['editing', 'model', 'view']);
    expect(sections.map(hasTopLine)).toEqual([false, true, true]);
    // Named groups for assistive tech.
    expect(screen.getByRole('group', { name: 'Model & layout' })).toBe(sections[1]);
    // Entries in their section, in `order`.
    expect([...sections[1].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['snap', 'path']);
  });

  it('a group whose components all render null is hidden — no doubled or edge divider', () => {
    register('groups-null', [
      { component: tool('undo'), order: 250, group: 'editing' },
      { component: Nothing, order: 200, group: 'model' },
      { component: Nothing, order: 201, group: 'model' },
      { component: tool('clip'), order: 65, group: 'view' },
      { component: Nothing, order: 10, group: 'analysis' },
    ]);
    renderPanel();

    const [editing, model, analysis, view] = sectionEls();
    expect([editing, model, analysis, view].map((s) => s.dataset.rvToolGroup))
      .toEqual(['editing', 'model', 'analysis', 'view']);
    expect(isShown(model)).toBe(false);
    expect(isShown(analysis)).toBe(false);
    // Exactly ONE line remains, between the two visible sections.
    const visible = sectionEls().filter(isShown);
    expect(visible.map((s) => s.dataset.rvToolGroup)).toEqual(['editing', 'view']);
    expect(visible.map(hasTopLine)).toEqual([false, true]);
  });

  it('a LEADING empty section leaves no divider at the top edge', () => {
    register('groups-leading', [
      { component: Nothing, order: 1 },
      { component: tool('undo'), order: 250, group: 'editing' },
      { component: tool('clip'), order: 65, group: 'view' },
    ]);
    renderPanel();

    const visible = sectionEls().filter(isShown);
    expect(visible.map((s) => s.dataset.rvToolGroup)).toEqual(['editing', 'view']);
    expect(visible.map(hasTopLine)).toEqual([false, true]);
  });

  it('without groups: one unnamed section, no divider, registration order', () => {
    register('plain-a', [{ component: tool('one'), order: 10 }, { component: tool('three'), order: 30 }]);
    register('plain-b', [{ component: tool('two'), order: 20 }]);
    renderPanel();

    const sections = sectionEls();
    expect(sections).toHaveLength(1);
    expect(sections[0].dataset.rvToolGroup).toBe(UNGROUPED_SECTION_KEY);
    expect(sections[0].hasAttribute('role')).toBe(false);
    expect(hasTopLine(sections[0])).toBe(false);
    expect([...sections[0].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['one', 'two', 'three']);
  });

  it('mobile bottom row: dividers turn vertical (border-left), never border-top', () => {
    layout.mobile = true;
    register('groups-mobile', [
      { component: tool('undo'), order: 250, group: 'editing' },
      { component: tool('snap'), order: 200, group: 'model' },
      { component: Nothing, order: 10, group: 'analysis' },
      { component: tool('clip'), order: 65, group: 'view' },
    ]);
    renderPanel();

    const sections = sectionEls();
    expect(sections.map((s) => getComputedStyle(s).flexDirection)).toEqual(['row', 'row', 'row', 'row']);
    expect(sections.map(hasTopLine)).toEqual([false, false, false, false]);
    const visible = sections.filter(isShown);
    expect(visible.map((s) => s.dataset.rvToolGroup)).toEqual(['editing', 'model', 'view']);
    expect(visible.map(hasLeftLine)).toEqual([false, true, true]);
  });

  it('an entry keeps its state when another plugin registers an earlier-sorted entry', () => {
    function Counter() {
      const [n, setN] = useState(0);
      return <button type="button" data-testid="counter" onClick={() => setN(n + 1)}>{n}</button>;
    }
    register('stateful', [{ component: Counter, order: 200, group: 'model' }]);
    renderPanel();
    fireEvent.click(screen.getByTestId('counter'));
    fireEvent.click(screen.getByTestId('counter'));
    expect(screen.getByTestId('counter').textContent).toBe('2');

    // Like the on-demand DES plugin: lower orders, same section, registered later.
    register('late-low-order', [
      { component: tool('early'), order: 50, group: 'model' },
      { component: tool('first'), order: 1 },
    ]);

    expect(screen.getByTestId('tool-early')).toBeTruthy();
    // Not remounted — a list-index key would have reset it to 0.
    expect(screen.getByTestId('counter').textContent).toBe('2');
  });
});
