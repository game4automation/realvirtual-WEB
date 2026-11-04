// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-764 §9.6 — the export provider registry (public seam).
 *
 * Same contract as `ImportProviderRegistry`: last-wins registration, sorted
 * listing, change notification, and a listener that throws does not break
 * the others. The public build ships it EMPTY — that is what makes the card
 * show only "Export .glb…" and the MCP tool answer `usd-export-unavailable`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ExportProviderRegistry,
  exportProviderRegistry,
  type DocumentExportProvider,
} from '../src/core/export/rv-export-provider';

function fake(id: string, label = id, order?: number): DocumentExportProvider {
  return {
    id,
    label,
    ...(order !== undefined ? { order } : {}),
    modes: () => [{ id: 'm', label: 'M', fileName: `x.${id}`, mime: 'application/octet-stream' }],
    run: async () => ({ bytes: new Uint8Array([1]), fileName: `x.${id}`, mime: 'application/octet-stream', stats: {} }),
  };
}

describe('ExportProviderRegistry', () => {
  it('registers, lists sorted by order then label, and unregisters', () => {
    const reg = new ExportProviderRegistry();
    reg.register(fake('b', 'Beta'));
    reg.register(fake('a', 'Alpha'));
    reg.register(fake('z', 'Zulu', 10));
    expect(reg.list().map((p) => p.id)).toEqual(['z', 'a', 'b']);
    expect(reg.get('a')?.label).toBe('Alpha');
    reg.unregister('a');
    expect(reg.get('a')).toBeUndefined();
    expect(reg.list().map((p) => p.id)).toEqual(['z', 'b']);
  });

  it('a second registration of the same id replaces the first (HMR-safe)', () => {
    const reg = new ExportProviderRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reg.register(fake('usd', 'Old'));
    reg.register(fake('usd', 'New'));
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('usd')?.label).toBe('New');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('notifies on register and unregister, not on a no-op unregister', () => {
    const reg = new ExportProviderRegistry();
    const cb = vi.fn();
    const off = reg.onChange(cb);
    reg.register(fake('usd'));
    reg.unregister('usd');
    reg.unregister('usd');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    reg.register(fake('usd'));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('a throwing listener does not stop the others', () => {
    const reg = new ExportProviderRegistry();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = vi.fn();
    reg.onChange(() => { throw new Error('boom'); });
    reg.onChange(second);
    reg.register(fake('usd'));
    expect(second).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('the global registry starts empty — the public build offers no non-GLB export', () => {
    expect(exportProviderRegistry.list()).toEqual([]);
  });
});
