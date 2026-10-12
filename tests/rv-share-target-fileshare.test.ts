// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-560 §9.2 — a bare fileshare landing link is pointed at its bytes. */

import { describe, it, expect } from 'vitest';
import { normalizeFileshareUrl, resolveShareTarget } from '../src/core/share/rv-share-target';

describe('normalizeFileshareUrl (plan-560)', () => {
  it('appends /file to /dl/<token>', () => {
    expect(normalizeFileshareUrl('https://files.realvirtual.io/dl/abc123'))
      .toBe('https://files.realvirtual.io/dl/abc123/file');
    expect(normalizeFileshareUrl('https://files.realvirtual.io/dl/abc123/'))
      .toBe('https://files.realvirtual.io/dl/abc123/file');
  });

  it('leaves /dl/<token>/file unchanged', () => {
    expect(normalizeFileshareUrl('https://files.realvirtual.io/dl/abc123/file'))
      .toBe('https://files.realvirtual.io/dl/abc123/file');
  });

  it('leaves other hosts and other paths unchanged', () => {
    expect(normalizeFileshareUrl('https://example.org/dl/abc123')).toBe('https://example.org/dl/abc123');
    expect(normalizeFileshareUrl('https://files.realvirtual.io/other/abc123'))
      .toBe('https://files.realvirtual.io/other/abc123');
    expect(normalizeFileshareUrl('https://files.realvirtual.io/dl/abc/def'))
      .toBe('https://files.realvirtual.io/dl/abc/def');
  });

  it('keeps query and fragment', () => {
    expect(normalizeFileshareUrl('https://files.realvirtual.io/dl/abc123?x=1#y'))
      .toBe('https://files.realvirtual.io/dl/abc123/file?x=1#y');
  });

  it('is applied by resolveShareTarget for the url form', async () => {
    await expect(resolveShareTarget('https://files.realvirtual.io/dl/tok')).resolves
      .toBe('https://files.realvirtual.io/dl/tok/file');
    await expect(resolveShareTarget('https://cdn.example.org/a.glb')).resolves
      .toBe('https://cdn.example.org/a.glb');
  });
});
