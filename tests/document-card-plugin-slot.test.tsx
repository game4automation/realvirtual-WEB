// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.6 — the PLUGIN slot's six chip states (§3.1).
 *
 * The slot is the third `RefSlotTile` on the hero card and is deliberately a
 * DROP-IN: everything CONNECT and knowledge already do it does identically, and
 * the one thing it adds is a runtime verdict. So this file pins two different
 * things:
 *
 *  1. the six states are visually distinguishable and each says WHY (the
 *     tooltip is the whole point of F3/F4 — a chip that only changes colour
 *     leaves the user exactly as uninformed as the console warning did);
 *  2. the two existing slots are untouched by the third one arriving.
 *
 * Renderer-free like `document-card.test.tsx`: the card reads one seam.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DocumentCard, type DocumentCardRefSlot } from '../src/core/hmi/scene/DocumentCard';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';

function view(): ActiveDocumentView {
  return {
    name: 'DemoRibbonTension',
    crumbs: [{
      index: 0, label: 'DemoRibbonTension', occurrence: '', referenceNodeId: null,
      dirty: false, stale: false, current: true,
    }],
    dirty: false,
    busy: false,
    stackDirty: false,
    stale: false,
    saveVerb: 'save',
    sourceMode: 'planner',
    actions: { save: async () => ({ status: 'saved' }) },
  } as unknown as ActiveDocumentView;
}

function mount(plugin: DocumentCardRefSlot | null, extra: Record<string, unknown> = {}) {
  setActiveDocumentView(view());
  return render(
    <DocumentCard variant="hero" activeMode={null} plugin={plugin} {...extra} />,
  );
}

/** The tile element of the plugin slot, bound or empty. */
function tile(bound = true): HTMLElement {
  return screen.getByTestId(bound ? 'document-card-plugin' : 'document-card-plugin-empty');
}

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
});

describe('plan-479 §9.6 — the six chip states', () => {
  it('1. empty — the ghost slot, and it says a drag would fill it', () => {
    mount({ kind: 'empty', droppable: true });
    const el = tile(false);
    expect(el.textContent).toContain('None');
    expect(el.getAttribute('title')).toMatch(/drag/i);
    expect(screen.queryByTestId('document-card-plugin')).toBeNull();
  });

  it('1b. empty and read-only — states the fact without promising the gesture', () => {
    mount({ kind: 'empty', droppable: false });
    expect(tile(false).getAttribute('title')).toMatch(/no project plugin referenced/i);
  });

  it('2. bound — the file name, no verdict yet, and no state word', () => {
    mount({ kind: 'bound', label: 'ribbon-tension-controls-plugin.tsx', onReveal: () => {} });
    expect(tile().textContent).toContain('ribbon-tension-controls-plugin.tsx');
    // "Bound, nothing known yet" is the honest state before a model is loaded.
    expect(screen.queryByTestId('document-card-plugin-state')).toBeNull();
    expect(screen.queryByTestId('document-card-plugin-loaded')).toBeNull();
  });

  it('3. loaded — the tick the other two slots can never have', () => {
    mount({
      kind: 'bound',
      label: 'index.ts',
      status: 'loaded',
      statusDetail: 'Loaded from the build',
      onReveal: () => {},
    });
    expect(screen.getByTestId('document-card-plugin-loaded')).toBeTruthy();
    expect(tile().getAttribute('title')).toContain('Loaded from the build');
    // Loaded is a GOOD state — it must not borrow the warning word.
    expect(screen.queryByTestId('document-card-plugin-state')).toBeNull();
  });

  it('4. missing — the file is not in the project, and the chip does not link', () => {
    mount({ kind: 'bound', label: 'gone.ts', missing: true });
    expect(screen.getByTestId('document-card-plugin-state').textContent).toBe('missing');
    expect(tile().getAttribute('title')).toMatch(/missing from the project/i);
  });

  it('5. no-exports — the source scan found no register/unregister pair', () => {
    mount({
      kind: 'bound',
      label: 'util.ts',
      status: 'no-exports',
      statusDetail: 'exports no registerModelPlugins/unregisterModelPlugins pair',
      onReveal: () => {},
    });
    expect(screen.getByTestId('document-card-plugin-state').textContent).toBe('no plugin');
    expect(tile().getAttribute('title')).toContain('registerModelPlugins');
  });

  it('6. failed — the module threw, and the message is the tooltip', () => {
    mount({
      kind: 'bound',
      label: 'index.ts',
      status: 'failed',
      statusDetail: 'register threw: Cannot read properties of undefined',
      onReveal: () => {},
    });
    expect(screen.getByTestId('document-card-plugin-state').textContent).toBe('error');
    expect(tile().getAttribute('title')).toContain('Cannot read properties of undefined');
  });

  it('a missing file outranks a stale runtime verdict', () => {
    // The runtime store may still hold the last load's answer when the file has
    // since been deleted. "It is not there" is the more useful of the two.
    mount({ kind: 'bound', label: 'gone.ts', missing: true, status: 'loaded' });
    expect(screen.getByTestId('document-card-plugin-state').textContent).toBe('missing');
    expect(screen.queryByTestId('document-card-plugin-loaded')).toBeNull();
  });
});

describe('plan-479 §9.6 — the slot behaves like its two siblings', () => {
  it('reveals on click and clears on the ×', () => {
    let revealed = 0;
    let cleared = 0;
    mount({
      kind: 'bound',
      label: 'index.ts',
      onReveal: () => { revealed += 1; },
      onClear: () => { cleared += 1; },
    });

    fireEvent.click(tile());
    expect(revealed).toBe(1);

    fireEvent.click(screen.getByLabelText('Clear Plugin binding'));
    expect(cleared).toBe(1);
    // The clear must not also fire the reveal underneath it.
    expect(revealed).toBe(1);
  });

  it('offers no × when the project is read-only', () => {
    mount({ kind: 'bound', label: 'index.ts', onReveal: () => {} });
    expect(screen.queryByLabelText('Clear Plugin binding')).toBeNull();
  });

  it('renders nothing at all when the card is given no plugin slot', () => {
    mount(null);
    expect(screen.queryByTestId('document-card-plugin')).toBeNull();
    expect(screen.queryByTestId('document-card-plugin-empty')).toBeNull();
  });

  it('stands beside CONNECT and knowledge without disturbing either', () => {
    mount(
      { kind: 'bound', label: 'index.ts' },
      {
        connect: { kind: 'bound', label: 'line1' } as DocumentCardRefSlot,
        knowledge: { kind: 'empty', droppable: true } as DocumentCardRefSlot,
      },
    );
    expect(screen.getByTestId('document-card-connect').textContent).toContain('line1');
    expect(screen.getByTestId('document-card-knowledge-empty')).toBeTruthy();
    expect(screen.getByTestId('document-card-plugin').textContent).toContain('index.ts');
  });
});
