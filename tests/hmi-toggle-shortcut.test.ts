// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The eye button in the view controls says "Toggle HMI (H)"; the shortcut did
 * not exist. `isHmiToggleKey` is the rule of the new global H shortcut.
 */
import { describe, it, expect } from 'vitest';
import { isHmiToggleKey } from '../src/core/hmi/hmi-visibility-store';

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat', boolean>> = {}) => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods,
});
const idle = { typing: false, editorActive: false };

describe('H shortcut — hide / show the HMI overlay', () => {
  it('H and h toggle', () => {
    expect(isHmiToggleKey(key('h'), idle)).toBe(true);
    expect(isHmiToggleKey(key('H'), idle)).toBe(true);
  });
  it('never with a modifier, never on key repeat', () => {
    for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat'] as const) {
      expect(isHmiToggleKey(key('h', { [m]: true }), idle)).toBe(false);
    }
  });
  it('not while typing, not in the asset editor (H hides the selection there)', () => {
    expect(isHmiToggleKey(key('h'), { typing: true, editorActive: false })).toBe(false);
    expect(isHmiToggleKey(key('h'), { typing: false, editorActive: true })).toBe(false);
  });
  it('other keys do nothing', () => {
    expect(isHmiToggleKey(key('g'), idle)).toBe(false);
  });
});
