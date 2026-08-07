// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-shortcut.test.ts — `/` and Ctrl/Cmd+K route to the global search
 * (plan-283 review H7). The critical contract is the guard: the shortcut must
 * NEVER fire while the user types in an input context.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isSearchShortcut, isEditableTarget } from '../src/core/hmi/search-shortcut';

function ev(key: string, target: EventTarget | null, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, target, ...mods };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isSearchShortcut', () => {
  it('fires for "/" on a non-editable target (happy path)', () => {
    expect(isSearchShortcut(ev('/', document.body))).toBe(true);
  });

  it('fires for Ctrl+K and Cmd+K', () => {
    expect(isSearchShortcut(ev('k', document.body, { ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(ev('K', document.body, { metaKey: true }))).toBe(true);
  });

  it('does NOT fire for "/" when focus is in an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(isSearchShortcut(ev('/', input))).toBe(false);
  });

  it('does NOT fire when focus is in a textarea or contenteditable', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    expect(isSearchShortcut(ev('/', textarea))).toBe(false);

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const span = document.createElement('span');
    editable.appendChild(span);
    document.body.appendChild(editable);
    // Nested target inside a contenteditable is also guarded (closest()).
    expect(isSearchShortcut(ev('/', span))).toBe(false);
  });

  it('does NOT fire for unrelated keys or modified "/"', () => {
    expect(isSearchShortcut(ev('a', document.body))).toBe(false);
    expect(isSearchShortcut(ev('/', document.body, { ctrlKey: true }))).toBe(false);
    expect(isSearchShortcut(ev('k', document.body))).toBe(false);          // bare k
    expect(isSearchShortcut(ev('k', document.body, { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('Ctrl+K is also guarded in inputs', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(isSearchShortcut(ev('k', input, { ctrlKey: true }))).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('null / non-element targets are not editable', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});
