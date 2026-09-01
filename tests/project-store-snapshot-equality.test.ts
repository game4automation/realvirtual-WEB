// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snapshot equality — every row field a publish can change must be part of
 * `sameDocuments`, or the change never reaches `useSyncExternalStore`.
 *
 * The defect this pins: `setDocumentConnectRef` published a documents list
 * whose only difference was the ref field, `sameDocuments` did not compare it,
 * and the store kept the OLD array identity — the hero's CONNECT chip neither
 * appeared on a drop nor disappeared on a clear (2026-08-19).
 */

import { describe, it, expect } from 'vitest';
import { sameDocuments } from '../src/core/project/project-store';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';

function row(overrides: Partial<TieredDocumentEntry> = {}): TieredDocumentEntry {
  return {
    id: 'doc_1', name: 'Machine', path: 'models/machine.glb', tier: 'user',
    ...overrides,
  } as TieredDocumentEntry;
}

describe('sameDocuments — the reference fields are row state', () => {
  it('an added, changed or cleared connectRef IS a change', () => {
    expect(sameDocuments([row()], [row({ connectRef: 'line.connect.json' })])).toBe(false);
    expect(sameDocuments(
      [row({ connectRef: 'a.connect.json' })],
      [row({ connectRef: 'b.connect.json' })],
    )).toBe(false);
    expect(sameDocuments([row({ connectRef: 'a.connect.json' })], [row()])).toBe(false);
  });

  it('scriptRef and knowledgeRef count the same way', () => {
    expect(sameDocuments([row()], [row({ scriptRef: 'code/machine.js' })])).toBe(false);
    expect(sameDocuments([row()], [row({ knowledgeRef: 'docs/machine.md' })])).toBe(false);
  });

  it('identical rows still compare equal', () => {
    expect(sameDocuments(
      [row({ connectRef: 'line.connect.json' })],
      [row({ connectRef: 'line.connect.json' })],
    )).toBe(true);
  });
});
