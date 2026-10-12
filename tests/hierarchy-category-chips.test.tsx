// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-597 §9.4 — HierarchyCategoryChips: dynamic categories, split chip,
 * type menu, toolbar keyboard contract and focus when a ▾ disappears.
 */

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { HierarchyCategoryChips } from '../src/core/hmi/HierarchyCategoryChips';
import type { TypeCounts } from '../src/core/hmi/hierarchy-rows';
import type { HierarchyFilterId } from '../src/core/hmi/hierarchy-utils';
import type { CategoryId } from '../src/core/engine/rv-component-category';

afterEach(cleanup);

/** Counts from a compact spec: { category: { label: n } }; category count = sum. */
function countsOf(spec: Partial<Record<CategoryId, Record<string, number>>>, total = 100): TypeCounts {
  const byCategory = new Map<CategoryId, number>();
  const byLabel = new Map<CategoryId, Map<string, number>>();
  const labelType = new Map<string, string>();
  for (const [cat, labels] of Object.entries(spec) as Array<[CategoryId, Record<string, number>]>) {
    const m = new Map<string, number>();
    let sum = 0;
    for (const [label, n] of Object.entries(labels)) { m.set(label, n); sum += n; labelType.set(`${cat}/${label}`, label); }
    byLabel.set(cat, m);
    byCategory.set(cat, sum);
  }
  return { total, withOverrides: 0, runtimeHidden: 0, bakedHidden: 0, byCategory, byLabel, labelType };
}

const MODEL = countsOf({
  drives: { Drives: 21 },
  transport: { Conveyors: 12, 'Transport Stoppers': 2 },
  signals: { PLCOutputBool: 30, PLCInputBool: 22 },
});

/** Controlled wrapper so clicks round-trip into `value`. */
function Harness({ counts = MODEL, matchCounts = null, initial = 'all' as HierarchyFilterId, onChange }: {
  counts?: TypeCounts; matchCounts?: TypeCounts | null; initial?: HierarchyFilterId; onChange?: (id: HierarchyFilterId) => void;
}) {
  const [value, setValue] = useState<HierarchyFilterId>(initial);
  return (
    <HierarchyCategoryChips
      counts={counts}
      matchCounts={matchCounts}
      value={value}
      onChange={(id) => { onChange?.(id); setValue(id); }}
    />
  );
}

const toolbar = () => screen.getByRole('toolbar', { name: 'Filter by type' });
const labelButton = (name: RegExp) => within(toolbar()).getByRole('button', { name });

describe('HierarchyCategoryChips (§9.4)', () => {
  it('renders All plus only the categories with hits, in CATEGORY_ORDER', () => {
    render(<Harness />);
    const groups = within(toolbar()).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Drives', 'Transport', 'Signals']);
    expect(labelButton(/^All, 100$/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Sensors' })).toBeNull();
  });

  it('keeps an active category visible at 0', () => {
    render(<Harness initial="cat:sensors" />);
    expect(screen.getByRole('group', { name: 'Sensors' })).toBeTruthy();
    expect(labelButton(/^Sensors, 0$/).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows ▾ only for a category with at least two labels', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Drives types' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Transport types' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Signals types' })).toBeTruthy();
  });

  it('opens a menu of menuitemradio entries with counts and aria-checked', () => {
    render(<Harness initial="cat:transport" />);
    const trigger = screen.getByRole('button', { name: 'Transport types' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.hasAttribute('aria-expanded')).toBe(false);
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['All Transport14', 'Conveyors12', 'Transport Stoppers2']);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    expect(items[1]!.getAttribute('aria-checked')).toBe('false');
  });

  it('picking an entry calls onChange with cat:transport/Conveyors and shows it in the chip', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transport types' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /Conveyors/ }));
    expect(onChange).toHaveBeenLastCalledWith('cat:transport/Conveyors');
    const label = labelButton(/^Transport › Conveyors, 12$/);
    expect(label.textContent).toBe('Transport › Conveyors12');
    expect(screen.getByRole('group', { name: 'Transport' }).getAttribute('title')).toBe('Transport › Conveyors 12');
  });

  it('toggle flow: inactive → cat:x, label → cat:x, cat:x → all', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="cat:transport/Conveyors" />);
    fireEvent.click(labelButton(/^Transport › Conveyors/));
    expect(onChange).toHaveBeenLastCalledWith('cat:transport');
    fireEvent.click(labelButton(/^Transport, 14$/));
    expect(onChange).toHaveBeenLastCalledWith('all');
    fireEvent.click(labelButton(/^Drives, 21$/));
    expect(onChange).toHaveBeenLastCalledWith('cat:drives');
    expect(labelButton(/^Drives, 21$/).getAttribute('aria-pressed')).toBe('true');
    expect(labelButton(/^All, 100$/).getAttribute('aria-pressed')).toBe('false');
  });

  it('Escape closes the menu and focus returns to ▾', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Transport types' });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('ArrowDown on ▾ opens the menu', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Signals types' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('roving tabindex: one tab stop, ←/→ across label and ▾ parts, Home/End', () => {
    render(<Harness />);
    const parts = Array.from(toolbar().querySelectorAll<HTMLElement>('[data-rv-chip-part]'));
    // All, Drives, Transport, Transport ▾, Signals, Signals ▾
    expect(parts.map((p) => p.dataset.rvChipPart)).toEqual(['all', 'drives', 'transport', 'transport:menu', 'signals', 'signals:menu']);
    expect(parts.filter((p) => p.tabIndex === 0)).toHaveLength(1);
    expect(parts[0]!.tabIndex).toBe(0);

    parts[0]!.focus();
    fireEvent.keyDown(parts[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(parts[1]);
    fireEvent.keyDown(parts[1]!, { key: 'ArrowRight' });
    fireEvent.keyDown(parts[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(parts[3]); // the ▾ is a stop of its own
    fireEvent.keyDown(parts[3]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(parts[2]);
    fireEvent.keyDown(parts[2]!, { key: 'End' });
    expect(document.activeElement).toBe(parts[5]);
    fireEvent.keyDown(parts[5]!, { key: 'Home' });
    expect(document.activeElement).toBe(parts[0]);
    const now = Array.from(toolbar().querySelectorAll<HTMLElement>('[data-rv-chip-part]'));
    expect(now.filter((p) => p.tabIndex === 0)).toEqual([parts[0]]);
  });

  it('moves focus to the label part when the focused ▾ disappears', async () => {
    const { rerender } = render(<HierarchyCategoryChips counts={MODEL} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Transport types' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const single = countsOf({ drives: { Drives: 21 }, transport: { Conveyors: 12 }, signals: { PLCOutputBool: 30, PLCInputBool: 22 } });
    await act(async () => {
      rerender(<HierarchyCategoryChips counts={single} value="all" onChange={() => {}} />);
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: 'Transport types' })).toBeNull();
    const label = labelButton(/^Transport, 12$/);
    expect(document.activeElement).toBe(label);
    expect(label.tabIndex).toBe(0);
  });

  it('a type whose plugin declared an unknown category appears under Other', () => {
    render(<Harness counts={countsOf({ other: { Gizmos: 3 } })} />);
    expect(screen.getByRole('group', { name: 'Other' })).toBeTruthy();
    expect(labelButton(/^Other, 3$/)).toBeTruthy();
  });
});

describe('HierarchyCategoryChips — Phase 6b fix batch', () => {
  it('keys inside the open ▾ menu stay in the menu (portal events do not reach the toolbar)', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Signals types' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await vi.waitFor(() => screen.getByRole('menu'));
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    await vi.waitFor(() => expect(items).toContain(document.activeElement));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(items[2]);
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items[0]);
    expect(screen.getByRole('menu')).toBe(menu);
  });

  it('a menu whose ▾ disappeared does not re-open by itself when ▾ comes back', async () => {
    const { rerender } = render(<HierarchyCategoryChips counts={MODEL} value="all" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transport types' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    const single = countsOf({ drives: { Drives: 21 }, transport: { Conveyors: 12 }, signals: { PLCOutputBool: 30, PLCInputBool: 22 } });
    await act(async () => { rerender(<HierarchyCategoryChips counts={single} value="all" onChange={() => {}} />); });
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await act(async () => { rerender(<HierarchyCategoryChips counts={MODEL} value="all" onChange={() => {}} />); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('menu')).toBeNull();
    const back = screen.getByRole('button', { name: 'Transport types' });
    expect(back.hasAttribute('aria-expanded')).toBe(false);
  });

  it('shows matching/total on every chip and menu entry while a search runs', () => {
    const match = countsOf({ transport: { Conveyors: 3 }, signals: { PLCOutputBool: 1 } }, 5);
    render(<Harness matchCounts={match} />);
    const all = labelButton(/^All, 5 of 100$/);
    expect(all.textContent).toBe('All5/100');
    expect(labelButton(/^Transport, 3 of 14$/).textContent).toBe('Transport3/14');
    // A category with no hit shows 0/n — it stays (rendering follows the totals).
    expect(labelButton(/^Drives, 0 of 21$/).textContent).toBe('Drives0/21');
    expect(screen.getByRole('group', { name: 'Transport' }).getAttribute('title')).toBe('Transport 3/14');
    fireEvent.click(screen.getByRole('button', { name: 'Transport types' }));
    const menu = screen.getByRole('menu');
    const names = within(menu).getAllByRole('menuitemradio').map((i) => i.getAttribute('aria-label'));
    expect(names).toEqual(['All Transport, 3 of 14', 'Conveyors, 3 of 12', 'Transport Stoppers, 0 of 2']);
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent))
      .toEqual(['All Transport3/14', 'Conveyors3/12', 'Transport Stoppers0/2']);
  });

  it('without a search the counts stay plain totals, and an active 0-chip reads "0 of 0" in a search', () => {
    const { unmount } = render(<Harness />);
    expect(labelButton(/^Transport, 14$/).textContent).toBe('Transport14');
    unmount();
    render(<Harness initial="cat:sensors" matchCounts={countsOf({}, 0)} />);
    expect(labelButton(/^Sensors, 0 of 0$/).getAttribute('aria-pressed')).toBe('true');
  });

  it('split chip: 2 px focus ring inside the part (also on an active chip), visible split line', async () => {
    render(<Harness initial="cat:transport" />);
    const label = labelButton(/^Transport, 14$/);
    label.focus();
    await userEvent.keyboard('{ArrowRight}');
    const trigger = screen.getByRole('button', { name: 'Transport types' });
    expect(document.activeElement).toBe(trigger);
    const ring = getComputedStyle(trigger);
    expect(ring.outlineWidth).toBe('2px');
    expect(ring.outlineStyle).toBe('solid');
    expect(ring.outlineOffset).toBe('-2px');
    // Split line: 1 px, as strong as the active chip's own accent border.
    expect(ring.borderLeftWidth).toBe('1px');
    const group = screen.getByRole('group', { name: 'Transport' });
    expect(ring.borderLeftColor).toBe(getComputedStyle(group).borderTopColor);
    // Active chip text is Ink High, not accent text (>= 4.5:1, Phase 6b).
    expect(getComputedStyle(group).color).toBe('rgba(255, 255, 255, 0.92)');
    // Same weight active and inactive: no reflow on activation.
    expect(getComputedStyle(group).fontWeight).toBe(getComputedStyle(screen.getByRole('group', { name: 'Drives' })).fontWeight);
  });
});
