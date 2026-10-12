// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RuntimeMetadata `<link url>` resolution (3D-HMI manuals): a relative path
 * that names a file of the OPEN project opens that file; everything else keeps
 * the legacy meaning (absolute → web, relative → documentation site).
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveMetadataLink, DOC_BASE_URL } from '../src/core/hmi/tooltip/metadata-link-resolver';

function backendWith(files: Record<string, string>) {
  const release = vi.fn();
  return {
    release,
    backend: {
      readDocumentUrl: vi.fn(async (rel: string) => (rel in files ? { url: files[rel], release } : null)),
    },
  };
}

describe('resolveMetadataLink', () => {
  it('absolute http(s) URLs are web links, the project is never asked', async () => {
    const { backend } = backendWith({});
    const t = await resolveMetadataLink('https://kroenert.de/service', backend);
    expect(t).toEqual({ kind: 'web', href: 'https://kroenert.de/service' });
    expect(backend.readDocumentUrl).not.toHaveBeenCalled();
  });

  it('a relative path the open project holds resolves to the project file (PDF → in-app viewer)', async () => {
    const rel = 'Kroenert Files/FA11k Documents/Final Documentation CD/01-Operation/260_MK_38780_FSU10WGKS_BAL_ENU.pdf';
    const { backend } = backendWith({ [rel]: 'blob:fa11-manual' });
    const t = await resolveMetadataLink(rel, backend);
    expect(t.kind).toBe('project');
    if (t.kind !== 'project') return;
    expect(t.url).toBe('blob:fa11-manual');
    expect(t.isPdf).toBe(true);
    expect(backend.readDocumentUrl).toHaveBeenCalledWith(rel);
  });

  it('normalises backslashes and a leading ./ or / before asking the backend', async () => {
    const { backend } = backendWith({ 'docs/a.png': 'blob:a' });
    const t = await resolveMetadataLink('.\\docs\\a.png', backend);
    expect(t.kind).toBe('project');
    if (t.kind === 'project') expect(t.isPdf).toBe(false);
    expect(backend.readDocumentUrl).toHaveBeenCalledWith('docs/a.png');
  });

  it('a relative path the project does NOT hold falls back to the documentation site', async () => {
    const { backend } = backendWith({});
    const t = await resolveMetadataLink('components/drive', backend);
    expect(t).toEqual({ kind: 'doc', href: `${DOC_BASE_URL}components/drive` });
  });

  it('without an open project a relative link is a documentation link (legacy demo content)', async () => {
    const t = await resolveMetadataLink('components/drive', null);
    expect(t).toEqual({ kind: 'doc', href: `${DOC_BASE_URL}components/drive` });
  });

  it('a backend that throws is treated like "not held"', async () => {
    const backend = { readDocumentUrl: vi.fn(async () => { throw new Error('permission lapsed'); }) };
    const t = await resolveMetadataLink('docs/x.pdf', backend);
    expect(t.kind).toBe('doc');
  });
});
