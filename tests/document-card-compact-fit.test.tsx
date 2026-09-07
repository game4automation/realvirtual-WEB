// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The compact document card FITS its panel header (2026-09-07).
 *
 * The card is the title of the hierarchy window, and that window is 320 px by
 * default and resizable down to 200. Its breadcrumb is the full trail —
 * location segments plus one chip per descend — so the row is routinely asked
 * to show far more text than it has width for. It used to answer with
 * `overflow-x: auto`: a scrollbar under the panel title, a Save button pushed
 * out of reach, and a name whose beginning and end were both off screen.
 *
 * Geometry, not snapshots. What is promised is measurable: nothing in the row
 * overflows, the Save button stays whole and inside, and the thing the user
 * actually needs — the name of the document they are editing — is the last
 * text to give way. A screenshot test would go red on a font bump; these
 * assertions only go red when the row genuinely stops fitting.
 */

import { page } from 'vitest/browser';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DocumentCard } from '../src/core/hmi/scene/DocumentCard';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
});

function crumb(label: string, over: Record<string, unknown> = {}) {
  return {
    index: 0, label, occurrence: '', referenceNodeId: null,
    dirty: false, stale: false, current: true, ...over,
  };
}

/** The worst trail the product can produce: deep location, deep descend. */
const LONG_VIEW: ActiveDocumentView = {
  name: 'AGV - Forklifter Mast Assembly Rev C',
  location: ['Development', 'Library', 'Vehicles'],
  crumbs: [
    crumb('Warehouse Layout North', { index: 0, current: false }),
    crumb('Aisle 12 Pick Station', { index: 1, current: false }),
    crumb('AGV - Forklifter Mast Assembly Rev C', { index: 2 }),
  ],
  dirty: true,
  busy: false,
  stackDirty: true,
  stale: false,
  saveVerb: 'save',
  sourceMode: 'editor',
  actions: {
    save: async () => ({ status: 'saved' }),
    onCrumb: () => {},
    menu: [{ id: 'rename', label: 'Rename…', run: async () => {} }],
  },
};

/**
 * The card inside the panel header it actually lives in: a fixed-width column
 * with the header's own padding, exactly what `LeftPanel` gives its title.
 */
function mountInPanel(width: number, view: ActiveDocumentView = LONG_VIEW) {
  setActiveDocumentView(view);
  return render(
    <div style={{ width, padding: '10px 12px', boxSizing: 'border-box' }}>
      <DocumentCard variant="compact" activeMode="editor" />
    </div>,
  );
}

/** Every element that could scroll, at every panel width users can set. */
const WIDTHS = [200, 260, 320, 420];

describe('the compact card fits its panel header', () => {
  /**
   * Two different things, and only one of them is a defect.
   *
   * A group that has collapsed to its floor reports `scrollWidth` far past its
   * `clientWidth` — that is what `text-overflow: ellipsis` IS, and asserting
   * against it would forbid the very mechanism the row depends on. What must
   * never happen is the row LAYING OUT wider than the panel (children that
   * refuse to shrink), or any element offering a scrollbar to reach the rest.
   */
  it('never scrolls horizontally, at any panel width', async () => {
    await page.viewport(1280, 720);
    for (const width of WIDTHS) {
      const rendered = mountInPanel(width);
      const card = screen.getByTestId('document-card');
      const trail = screen.getByTestId('document-trail');

      expect(card.scrollWidth, `the card overflows its panel at ${width}px`)
        .toBeLessThanOrEqual(card.clientWidth + 1);
      expect(trail.scrollWidth, `the trail lays out too wide at ${width}px`)
        .toBeLessThanOrEqual(trail.clientWidth + 1);

      for (const el of card.querySelectorAll('*')) {
        const overflowX = getComputedStyle(el).overflowX;
        expect(
          ['auto', 'scroll'].includes(overflowX),
          `${el.tagName}.${el.className || '(no class)'} offers a scrollbar at ${width}px`,
        ).toBe(false);
      }
      rendered.unmount();
      cleanup();
    }
  });

  it('keeps the Save button whole and inside the panel', async () => {
    await page.viewport(1280, 720);
    for (const width of WIDTHS) {
      const rendered = mountInPanel(width);
      const card = screen.getByTestId('document-card').getBoundingClientRect();
      const save = screen.getByTestId('document-card-save').getBoundingClientRect();
      expect(save.right, `Save is cut off at ${width}px`).toBeLessThanOrEqual(card.right + 1);
      expect(save.left).toBeGreaterThanOrEqual(card.left - 1);
      // Not squeezed to a sliver either — it still reads as a button.
      expect(save.width, `Save collapsed at ${width}px`).toBeGreaterThan(30);
      rendered.unmount();
      cleanup();
    }
  });

  /**
   * The priority IS the design: the open document is placed first, the
   * ancestors take what is left, the location takes what is left after that.
   */
  it('gives up the location before the document’s own name', async () => {
    await page.viewport(1280, 720);
    const rendered = mountInPanel(200);
    const location = screen.getByTestId('document-location').getBoundingClientRect();
    const current = screen.getByTestId('document-crumb-current').getBoundingClientRect();
    expect(current.width).toBeGreaterThan(location.width);
    rendered.unmount();
  });

  it('widens the trail back out when the panel has room', async () => {
    await page.viewport(1280, 720);
    const narrow = mountInPanel(220);
    const atNarrow = screen.getByTestId('document-ancestors').getBoundingClientRect().width;
    narrow.unmount();
    cleanup();

    const wide = mountInPanel(700);
    expect(screen.getByTestId('document-ancestors').getBoundingClientRect().width)
      .toBeGreaterThan(atNarrow);
    wide.unmount();
  });

  /**
   * A group is context or it is nothing.
   *
   * Leftover-space allocation hands a group whatever the name did not need,
   * and that can be four pixels — enough for the browser to paint the first
   * glyph of "Warehouse" in front of the title and nothing more. Anything
   * under the legibility threshold is closed instead, which is measurable:
   * a closed group has no width at all, never a sliver.
   */
  it('closes a prefix group rather than showing a sliver of one', async () => {
    await page.viewport(1280, 720);
    for (const width of WIDTHS) {
      const rendered = mountInPanel(width);
      for (const id of ['document-location', 'document-ancestors']) {
        const el = screen.getByTestId(id);
        const w = el.getBoundingClientRect().width;
        expect(
          w === 0 || w >= 40,
          `${id} rendered a ${w}px sliver at ${width}px`,
        ).toBe(true);
        // And the two agree: a closed group says so, a shown one has width.
        expect(el.getAttribute('data-shown')).toBe(String(w > 0));
      }
      rendered.unmount();
      cleanup();
    }
  });

  it('carries the whole trail in its tooltip, so nothing collapsed is lost', () => {
    mountInPanel(200);
    expect(screen.getByTestId('document-trail').getAttribute('title'))
      .toBe('Development › Library › Vehicles › Warehouse Layout North'
        + ' › Aisle 12 Pick Station › AGV - Forklifter Mast Assembly Rev C');
  });

  /**
   * One row, two things. The header was a six-control row (dot, trail, the
   * word UNSAVED, undo, redo, Save, kebab) in the narrowest panel of the app;
   * the trail lost to controls that all had a better home elsewhere.
   */
  it('holds the name and Save, and nothing else', () => {
    mountInPanel(320);
    const card = screen.getByTestId('document-card');
    expect(screen.queryByTestId('document-card-undo')).toBeNull();
    expect(screen.queryByTestId('document-card-redo')).toBeNull();
    expect(screen.queryByLabelText('More actions')).toBeNull();
    expect(card.textContent).not.toContain('Unsaved');
    expect(card.querySelectorAll('[data-testid="dirty-dot"]').length).toBe(1);
    expect(screen.getByTestId('document-card-save')).toBeTruthy();
  });
});
