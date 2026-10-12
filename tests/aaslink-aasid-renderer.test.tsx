// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-596 Phase 4 — the `AASLink.AASId` inspector renderer.
 *
 * The component is fetched from `fieldRendererRegistry` AFTER importing
 * `App.tsx`, the production bootstrap path: a renderer that `App.tsx` does not
 * side-effect-import registers in no running application, and this file then
 * fails as a whole (same stance as `rv-node-knowledge-field-renderer.test.tsx`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { fieldRendererRegistry, type FieldRendererProps } from '../src/core/hmi/rv-field-renderer-registry';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';
import { makeAasx } from './helpers/aasx-fixtures';
import { resetAasSources } from '../src/core/aas/rv-aas-source';
import { rescanProjectAasx, resetAasxProjectIndex } from '../src/core/aas/rv-aasx-project-index';
import { freeAasxName, sanitizeAasxBaseName, OTHER_ID_OPTION } from '../src/core/hmi/rv-aaslink-aasid-field-renderer';

const BOOTSTRAP_TIMEOUT = 180_000;
let Renderer: ComponentType<FieldRendererProps>;

beforeAll(async () => {
  await import('../src/core/hmi/App');
  const found = fieldRendererRegistry.getRenderer('AASLink', 'AASId');
  if (!found) {
    throw new Error("AASLink.AASId has no field renderer after importing App.tsx — the side-effect import is missing.");
  }
  Renderer = found;
}, BOOTSTRAP_TIMEOUT);

const A = { id: 'urn:festo:a', idShort: 'CylA', productName: 'Cylinder A' };
const B = { id: 'urn:festo:b', idShort: 'MotB', productName: 'Motor B' };
const C = { id: 'urn:festo:c', idShort: 'ValveC', productName: 'Valve C' };

let fx: FakeDocumentProject;
let ops: Array<{ fieldName: string; value: unknown; prev: unknown }>;

/** Give the fake browser-shaped backend the two read seams a scan uses. */
function withListing(f: FakeDocumentProject, writable = true): void {
  const b = f.backend as unknown as Record<string, unknown>;
  b.writable = writable;
  b.listAllFiles = async () => [...f.files.keys()].sort();
  b.readDocumentBlob = async (path: string) => {
    const bytes = f.files.get(path);
    return bytes ? new File([bytes as unknown as BlobPart], path.split('/').pop()!, { lastModified: bytes.length }) : null;
  };
}

function renderField(value: string) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <Renderer value={value} fieldName="AASId" componentType="AASLink" nodePath="Line/Cylinder" viewer={null} signalStore={null} />
    </ThemeProvider>,
  );
}

/** Make the next file-picker click deliver `file`. */
function pickNext(file: File): void {
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementationOnce(function (this: HTMLInputElement) {
    const dt = new DataTransfer();
    dt.items.add(file);
    this.files = dt.files;
    this.dispatchEvent(new Event('change'));
  });
}

beforeEach(async () => {
  resetAasSources();
  resetAasxProjectIndex();
  ops = [];
  setActiveEditTarget({
    available: true,
    setField: (_p: string, _t: string, fieldName: string, value: unknown, prev: unknown) => { ops.push({ fieldName, value, prev }); },
    unsetField: () => {},
  } as unknown as EditTarget);
  // The deploy-wide index is absent in this test.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
  fx = installFakeDocumentProject({ id: 'prj_aasx', files: { 'aasx/a.aasx': await makeAasx([A]) } });
  withListing(fx);
  await rescanProjectAasx();
});

afterEach(() => {
  cleanup();
  setActiveEditTarget(null);
  fx.restore();
  vi.restoreAllMocks();
});

describe('helpers', () => {
  it('sanitises and finds a free name', () => {
    expect(sanitizeAasxBaseName('Festo: DSBC/32.aasx')).toBe('Festo_ DSBC_32');
    expect(freeAasxName('a', ['aasx/a.aasx', 'aasx/a-2.aasx'])).toBe('a-3.aasx');
    expect(freeAasxName('b', ['aasx/a.aasx'])).toBe('b.aasx');
  });
});

describe('AASLink.AASId renderer', () => {
  it('lists the project entries; choosing one is exactly one undoable field write', async () => {
    renderField('');
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'AAS ID' }));
    const listbox = await screen.findByRole('listbox');
    const option = await within(listbox).findByRole('option', { name: 'Cylinder A — a.aasx' });
    expect(within(listbox).getByRole('option', { name: OTHER_ID_OPTION })).toBeTruthy();
    fireEvent.click(option);
    expect(ops).toEqual([{ fieldName: 'AASId', value: A.id, prev: '' }]);
  });

  it('keeps an unknown current value visible and says so', async () => {
    renderField('urn:elsewhere');
    expect(await screen.findByText('AAS ID not found in project')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'AAS ID' }).textContent).toContain('urn:elsewhere (not in project)');
  });

  it('Import AASX… copies into aasx/ under a free name and sets the id', async () => {
    renderField('');
    // A file named like the existing one: lands as a-2.aasx.
    pickNext(new File([await makeAasx([B]) as unknown as BlobPart], 'a.aasx'));
    fireEvent.click(await screen.findByRole('button', { name: 'Import AASX…' }));
    await waitFor(() => expect(ops).toEqual([{ fieldName: 'AASId', value: B.id, prev: '' }]));
    expect(fx.files.has('aasx/a-2.aasx')).toBe(true);
    expect(fx.writes.find(w => w.relPath === 'aasx/a-2.aasx')?.expected).toBeNull(); // 'create'
    const index = JSON.parse(new TextDecoder().decode(fx.files.get('aasx/index.json')!));
    expect(index.entries[B.id].file).toBe('a-2.aasx');
  });

  it('a file with several shells asks which one', async () => {
    renderField('');
    pickNext(new File([await makeAasx([B, C]) as unknown as BlobPart], 'multi.aasx'));
    fireEvent.click(await screen.findByRole('button', { name: 'Import AASX…' }));
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Shell' }));
    fireEvent.click(await screen.findByRole('option', { name: `Valve C (${C.id})` }));
    expect(ops).toEqual([{ fieldName: 'AASId', value: C.id, prev: '' }]);
  });

  it('a read-only project hides the import', async () => {
    withListing(fx, false);
    renderField('');
    await screen.findByRole('combobox', { name: 'AAS ID' });
    expect(screen.queryByRole('button', { name: 'Import AASX…' })).toBeNull();
  });
});
