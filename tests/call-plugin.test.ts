// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for callPlugin — plugin error isolation helper.
 *
 * Imports the real `callPlugin` from rv-viewer.ts (no inline copy).
 */

import { describe, it, expect, vi } from 'vitest';
import { callPlugin } from '../src/core/rv-viewer';

describe('callPlugin', () => {
  it('calls the method with correct arguments', () => {
    const plugin = { id: 'test', onFixedUpdatePre: vi.fn() };
    callPlugin(plugin as never, 'onFixedUpdatePre', 0.016);
    expect(plugin.onFixedUpdatePre).toHaveBeenCalledWith(0.016);
  });

  it('catches errors without rethrowing', () => {
    const plugin = { id: 'bad', onFixedUpdatePre: vi.fn(() => { throw new Error('boom'); }) };
    expect(() => callPlugin(plugin as never, 'onFixedUpdatePre', 0.016)).not.toThrow();
  });

  it('skips undefined methods', () => {
    const plugin = { id: 'minimal' };
    expect(() => callPlugin(plugin as never, 'onFixedUpdatePre', 0.016)).not.toThrow();
  });

  it('logs error with plugin id for diagnosability', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = { id: 'crashy', onRender: vi.fn(() => { throw new Error('render fail'); }) };
    callPlugin(plugin as never, 'onRender');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("'crashy'"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('passes multiple arguments correctly', () => {
    const plugin = { id: 'multi', onModelLoaded: vi.fn() };
    callPlugin(plugin as never, 'onModelLoaded', { drives: [] }, { scene: {} });
    expect(plugin.onModelLoaded).toHaveBeenCalledWith({ drives: [] }, { scene: {} });
  });

  it('skips non-function properties', () => {
    const plugin = { id: 'prop', onRender: 42 };
    expect(() => callPlugin(plugin as never, 'onRender', 0.016)).not.toThrow();
  });
});
