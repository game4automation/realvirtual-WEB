// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The detail pane's "Size" row for a selected GLB.
 *
 * The number comes out of the same `statDocuments()` pass that versions the
 * card thumbnails; this pins the one piece of logic between that stat and
 * the pane — what is printed, and when nothing is.
 */

import { describe, it, expect } from 'vitest';
import { formatDocumentSize } from '../src/core/hmi/projects/dashboard-documents';

describe('formatDocumentSize', () => {
  it('prints nothing for an absent, zero or unsizable body', () => {
    // The browser backend reports 0 for a blob it cannot measure — that is
    // "unknown", never "empty".
    expect(formatDocumentSize(undefined)).toBeNull();
    expect(formatDocumentSize(null)).toBeNull();
    expect(formatDocumentSize(0)).toBeNull();
    expect(formatDocumentSize(-5)).toBeNull();
    expect(formatDocumentSize(Number.NaN)).toBeNull();
  });

  it('scales through B, kB, MB and GB', () => {
    expect(formatDocumentSize(512)).toBe('512 B');
    expect(formatDocumentSize(999)).toBe('999 B');
    expect(formatDocumentSize(1000)).toBe('1.0 kB');
    expect(formatDocumentSize(153_600)).toBe('153.6 kB');
    expect(formatDocumentSize(24_300_000)).toBe('24.3 MB');
    expect(formatDocumentSize(1_500_000_000)).toBe('1.50 GB');
  });
});
