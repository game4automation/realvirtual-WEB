// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, it, expect, vi } from 'vitest';
import { parseHmiParam, loadInitial } from '../src/core/hmi/hmi-visibility-store';

describe('HMI URL override', () => {
  it('parses 0, 1, missing and unknown values', () => {
    expect(parseHmiParam('?hmi=0')).toBe(false);
    expect(parseHmiParam('?other=x&hmi=1')).toBe(true);
    for (const search of ['', '?other=0', '?hmi=', '?hmi=false', '?hmi=2']) {
      expect(parseHmiParam(search)).toBeUndefined();
    }
  });
  it('overrides storage in both directions without write-back', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      read.mockReturnValue('1');
      expect(loadInitial('?hmi=0')).toBe(false);
      read.mockReturnValue('0');
      expect(loadInitial('?hmi=1')).toBe(true);
      expect(loadInitial('?hmi=junk')).toBe(false);
      read.mockReturnValue(null);
      expect(loadInitial('')).toBe(true);
      expect(write).not.toHaveBeenCalled();
    } finally { read.mockRestore(); write.mockRestore(); }
  });
});
