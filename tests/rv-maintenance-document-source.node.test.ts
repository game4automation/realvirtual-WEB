// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A maintenance step's document link looks its AAS up through THE active AAS
 * source (project `aasx/` over the deploy directory). Before, it read only the
 * deploy-wide index, so a project AASX left the button grey with "AAS ID not
 * found in index" (blow-moulding demo, plan-2016 B).
 */

import { describe, expect, test, vi } from 'vitest';

const ACTIVE = { key: 'merged:project:p|url:/aasx/' };
const loadAasxById = vi.fn(async (_id: string, _source?: unknown) => ({
  documents: [{ title: 'Datenblatt Schließeinheit', mimeType: 'application/pdf', zipPath: 'aasx/datasheet.pdf', language: 'de' }],
}));

vi.mock('../src/core/aas/rv-aas-source', () => ({ getActiveAasSource: () => ACTIVE }));
vi.mock('../src/plugins/aas-link-parser', () => ({ loadAasxById }));
vi.mock('../src/core/aas/rv-aas-document-mirror', () => ({ prefetchAasDocumentMirrorFor: async () => {} }));

describe('maintenance document link — AAS source', () => {
  test('defaultLoadAas passes the active source to the lookup', async () => {
    const { defaultLoadAas } = await import('../src/core/hmi/maintenance-document-link');
    const got = await defaultLoadAas('https://demo.realvirtual.io/aas/demo/MLD-2000');
    expect(loadAasxById).toHaveBeenCalledWith('https://demo.realvirtual.io/aas/demo/MLD-2000', ACTIVE);
    expect(got.documents).toHaveLength(1);
  });

  test('a step link resolves to the project AASX document', async () => {
    const { resolveMaintenanceDocument } = await import('../src/core/hmi/maintenance-document-link');
    const node = { userData: { _rvAasLink: { aasId: 'https://demo.realvirtual.io/aas/demo/MLD-2000' } } };
    const resolved = await resolveMaintenanceDocument(
      { title: 'Datenblatt Schließeinheit', page: 0, url: '', sourcePath: 'Machine/KinematicMold/Fahrzylinder/MoldRight', keywords: ['datenblatt', 'datasheet'] },
      { registry: { getNode: () => node } },
      'de',
    );
    expect(resolved).toEqual({ kind: 'aas-blob', aasId: 'https://demo.realvirtual.io/aas/demo/MLD-2000', zipPath: 'aasx/datasheet.pdf', page: 0 });
  });
});
