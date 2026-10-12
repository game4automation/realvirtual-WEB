// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-478 §9.7 — the Quick-Open key predicate.
 *
 * A matrix rather than a handful of happy cases: this predicate's job is to
 * say NO, and the combinations it must refuse (a bare `f` while typing, the
 * browser's own `Ctrl+F`, the search palette's `Ctrl+K`) are each one keystroke
 * away from the one it must accept.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isRecentDocumentsShortcut } from '../src/core/hmi/recent-documents-shortcut';

function ev(over: Partial<{
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean;
  shiftKey: boolean; target: EventTarget | null;
}> = {}) {
  return {
    key: 'F', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true,
    target: null as EventTarget | null,
    ...over,
  };
}

describe('isRecentDocumentsShortcut', () => {
  it('accepts Ctrl+Shift+F and Cmd+Shift+F, in both letter cases', () => {
    expect(isRecentDocumentsShortcut(ev())).toBe(true);
    expect(isRecentDocumentsShortcut(ev({ key: 'f' }))).toBe(true);
    expect(isRecentDocumentsShortcut(ev({ ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isRecentDocumentsShortcut(ev({ key: 'f', ctrlKey: false, metaKey: true }))).toBe(true);
  });

  it('refuses everything one key away from it', () => {
    // The browser's own find.
    expect(isRecentDocumentsShortcut(ev({ shiftKey: false }))).toBe(false);
    // A bare letter — this must never steal a keystroke.
    expect(isRecentDocumentsShortcut(ev({ ctrlKey: false, shiftKey: false }))).toBe(false);
    expect(isRecentDocumentsShortcut(ev({ ctrlKey: false }))).toBe(false);
    // The global search palette.
    expect(isRecentDocumentsShortcut(ev({ key: 'k' }))).toBe(false);
    expect(isRecentDocumentsShortcut(ev({ key: '/' }))).toBe(false);
    // A plausible OS / window-manager binding passes straight through.
    expect(isRecentDocumentsShortcut(ev({ altKey: true }))).toBe(false);
  });
});

describe('the editable guard', () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    host.innerHTML = `
      <input id="text" />
      <textarea id="area"></textarea>
      <div id="rich" contenteditable="true"></div>
      <button id="btn"></button>`;
    document.body.appendChild(host);
  });
  afterEach(() => { host.remove(); });

  it('refuses while the focus is in any editable context', () => {
    for (const id of ['text', 'area', 'rich']) {
      const target = host.querySelector(`#${id}`);
      expect(isRecentDocumentsShortcut(ev({ target }))).toBe(false);
    }
  });

  it('fires on a non-editable target', () => {
    expect(isRecentDocumentsShortcut(ev({ target: host.querySelector('#btn') }))).toBe(true);
  });
});
