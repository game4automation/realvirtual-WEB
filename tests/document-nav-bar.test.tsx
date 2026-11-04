// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentNavBar — the top-left pill after following references:
 * [back arrow] root › … › current, root first, nothing without a chain.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { DocumentNavBar, collapseCrumbs, MAX_VISIBLE_CRUMBS } from '../src/core/hmi/DocumentNavBar';
import { clearDocumentNav, openReferencedDocument, type DocumentNavHost } from '../src/core/hmi/document-nav';
import { __resetOpenRecentInFlight } from '../src/core/hmi/projects/open-recent-entry';

const viewer = { modes: { activeMode: 'planner' } } as unknown as RVViewer;
const DOCS = [{ id: 'a', name: 'juju' }, { id: 'b', name: 'mhm' }, { id: 'c', name: 'fufu' }];

function host(): DocumentNavHost {
  let open = { documentId: 'a', name: 'juju' };
  let mode = 'planner';
  return {
    modes: {
      get activeMode() { return mode; },
      has: () => true,
      list: () => [{ id: 'planner' }],
      setMode: (m) => { mode = m; },
      runExitGuards: async () => true,
      acquireSwitchLock: () => Symbol('l'),
      releaseSwitchLock: () => {},
    },
    project: () => ({ id: 'p', backend: 'folder', name: 'p', isDemo: false, documents: DOCS }),
    openDocument: () => open,
    readLastMode: async () => 'planner',
    openAsWorkingScene: async (id) => { open = { documentId: id, name: DOCS.find((d) => d.id === id)!.name }; return true; },
    flushAutosave: async () => {},
    getCamera: () => null,
    restoreCamera: async () => {},
    notify: () => {},
  };
}

beforeEach(() => { clearDocumentNav(); __resetOpenRecentInFlight(); });
afterEach(() => { cleanup(); clearDocumentNav(); });

describe('DocumentNavBar', () => {
  it('renders nothing without a chain', () => {
    render(<DocumentNavBar viewer={viewer} />);
    expect(screen.queryByTestId('document-nav-bar')).toBeNull();
  });

  it('reads [back arrow] root › … › current', async () => {
    const h = host();
    await openReferencedDocument(h, 'b');
    await openReferencedDocument(h, 'c');
    render(<DocumentNavBar viewer={viewer} />);
    const bar = screen.getByTestId('document-nav-bar');
    const back = screen.getByTestId('document-nav-back');
    expect(back.getAttribute('aria-label')).toBe('Back to mhm');
    expect(screen.getByTestId('document-nav-crumb-0').textContent).toBe('juju');
    expect(screen.getByTestId('document-nav-crumb-1').textContent).toBe('mhm');
    expect(screen.getByTestId('document-nav-crumb-current').textContent).toBe('fufu');
    // Document order: back arrow, then the chain root-first.
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(back, screen.getByTestId('document-nav-crumb-0'))).toBe(true);
    const text = bar.textContent ?? '';
    expect(text.indexOf('juju')).toBeLessThan(text.indexOf('mhm'));
    expect(text.indexOf('mhm')).toBeLessThan(text.indexOf('fufu'));
  });
});

describe('collapseCrumbs', () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, label: `d${i}`, current: i === n - 1 }));

  it('keeps chains up to the limit as they are', () => {
    expect(collapseCrumbs(chain(MAX_VISIBLE_CRUMBS))).toEqual(chain(MAX_VISIBLE_CRUMBS));
  });

  it('collapses the middle of a longer chain: root, …, parent, current', () => {
    const slots = collapseCrumbs(chain(6));
    expect(slots).toHaveLength(4);
    expect(slots[0]).toEqual({ index: 0, label: 'd0', current: false });
    expect(slots[1]).toEqual({ more: [1, 2, 3].map((i) => ({ index: i, label: `d${i}`, current: false })) });
    expect(slots[2]).toEqual({ index: 4, label: 'd4', current: false });
    expect(slots[3]).toEqual({ index: 5, label: 'd5', current: true });
  });
});

describe('DocumentNavBar long chains', () => {
  it('shows "…" for the hidden middle and lists it in a menu', async () => {
    const docs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: `doc-${id}` }));
    let open = { documentId: 'a', name: 'doc-a' };
    const h: DocumentNavHost = {
      ...host(),
      project: () => ({ id: 'p', backend: 'folder', name: 'p', isDemo: false, documents: docs }),
      openDocument: () => open,
      openAsWorkingScene: async (id) => { open = { documentId: id, name: `doc-${id}` }; return true; },
    };
    for (const id of ['b', 'c', 'd', 'e', 'f']) await openReferencedDocument(h, id);
    render(<DocumentNavBar viewer={viewer} />);
    expect(screen.getByTestId('document-nav-crumb-0').textContent).toBe('doc-a');
    expect(screen.getByTestId('document-nav-crumb-4').textContent).toBe('doc-e');
    expect(screen.getByTestId('document-nav-crumb-current').textContent).toBe('doc-f');
    expect(screen.queryByTestId('document-nav-crumb-2')).toBeNull();
    fireEvent.click(screen.getByTestId('document-nav-crumb-more'));
    expect(screen.getByTestId('document-nav-more-1').textContent).toBe('doc-b');
    expect(screen.getByTestId('document-nav-more-3').textContent).toBe('doc-d');
  });
});
