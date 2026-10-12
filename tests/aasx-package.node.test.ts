// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-596 Phase 1 — the AASX package reader against the four REAL packages in
 * `public/aasx/` (Festo ×2, Bosch Rexroth, SEW).
 *
 * A Node test on purpose: it reads the files lazily through `fs.openAsBlob`,
 * which is what makes the 127 MB criterion measurable — every byte zip.js
 * touches goes through `Blob.slice`, and the spy sums those slices. The SEW
 * file is excluded from git (GitHub 100 MB limit); it is looked up in this
 * checkout and in the canonical sibling checkout and the case is SKIPPED, with
 * a note, where neither holds it. Node has no DOMParser; xmldom (already in the
 * tree through read-excel-file) stands in — the reader only uses DOM Level 2
 * calls that both implement.
 *
 * Synthetic packages (www.-relationship, backslash paths, missing
 * [Content_Types].xml, several shells, JSON, broken ZIP) are built with zip.js
 * in the test — no customer file is copied or modified.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, openAsBlob } from 'node:fs';
import { resolve } from 'node:path';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import {
  openAasxPackage,
  readAasxSummary,
  normalizePartPath,
  loadZipJs,
} from '../src/core/aas/rv-aasx-package';

const HERE = resolve(__dirname, '..');
const CANDIDATE_DIRS = [
  resolve(HERE, 'public/aasx'),
  // A worktree session does not carry the 127 MB file; the canonical checkout does.
  resolve(HERE, '../../../realvirtual6/game4automation/realvirtual/Assets/realvirtual-WebViewer~/public/aasx'),
  'E:/realvirtual6/game4automation/realvirtual/Assets/realvirtual-WebViewer~/public/aasx',
];

function fixture(name: string): string | null {
  for (const dir of CANDIDATE_DIRS) {
    const p = resolve(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Expected values, read off the packages in Phase 1 (all four are AAS V2 XML). */
const EXPECTED = [
  {
    file: '23_Festo.aasx',
    id: 'http://smart.festo.com/aas/99920200623113326000013225',
    idShort: 'Festo_EPCC-BS-32-100-3P-A_99920200623113326000013225',
    productName: 'Electric cylinder with spindle drive',
    manufacturer: 'Festo SE & Co. KG',
    globalAssetId: 'HTTP://PK.FESTO.COM/3S7PMT9D48W',
  },
  {
    file: '24_Festo.aasx',
    id: 'http://smart.festo.com/aas/99920200617190044000012858',
    idShort: 'Festo_EMME-AS-40-M-LV-AS_99920200617190044000012858',
    productName: 'Servo motor',
    manufacturer: 'Festo SE & Co. KG',
    globalAssetId: 'HTTP://PK.FESTO.COM/3S7PMVY0KD2',
  },
  {
    // No semanticIds at all in this package — the idShort fallback is what finds the values.
    file: '25_BoschRexroth.aasx',
    id: 'https://aas.boschrexroth.com/ctrlxdrive/R911410072-MS2N-Demo-0001',
    idShort: 'BoschRexroth_ctrlXDRIVE_MS2N_R911410072',
    productName: 'ctrlX DRIVE – Servo Drive System',
    manufacturer: 'Bosch Rexroth AG',
    globalAssetId: 'https://aas.boschrexroth.com/asset/ctrlxdrive/R911410072-MS2N-Demo-0001',
  },
  {
    file: '26_SEW_KA47-DRN90M4.aasx',
    id: 'https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001',
    idShort: 'SEW_KA47-DRN90M4',
    productName: 'Bevel-helical gear motor KA47 DRN90M4',
    manufacturer: 'SEW-EURODRIVE GmbH & Co KG',
    globalAssetId: 'https://demo.realvirtual.io/asset/sew/KA47-DRN90M4-Demo-0001',
  },
];

beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser;
});

/** Wrap a lazy Blob so every slice zip.js reads is counted. */
function countingBlob(blob: Blob): { blob: Blob; bytesRead: () => number } {
  let total = 0;
  const orig = blob.slice.bind(blob);
  (blob as { slice: Blob['slice'] }).slice = (start?: number, end?: number, type?: string) => {
    const s = Math.max(0, start ?? 0);
    const e = Math.min(blob.size, end ?? blob.size);
    total += Math.max(0, e - s);
    return orig(start, end, type);
  };
  return { blob, bytesRead: () => total };
}

// ─── Synthetic packages ─────────────────────────────────────────────────

async function makeZip(files: Record<string, string | Uint8Array>): Promise<Blob> {
  const zipjs = await loadZipJs();
  const writer = new zipjs.ZipWriter(new zipjs.BlobWriter('application/zip'));
  for (const [name, content] of Object.entries(files)) {
    await writer.add(name, typeof content === 'string' ? new zipjs.TextReader(content) : new zipjs.Uint8ArrayReader(content));
  }
  return writer.close();
}

const ROOT_RELS = (host: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://${host}admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin" Id="R1"/></Relationships>`;
const ORIGIN_RELS = (target: string, host = '') => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://${host}admin-shell.io/aasx/relationships/aas-spec" Target="${target}" Id="R2"/></Relationships>`;

const V3_TWO_SHELLS = `<?xml version="1.0"?>
<environment xmlns="https://admin-shell.io/aas/3/0">
  <assetAdministrationShells>
    <assetAdministrationShell>
      <idShort>ShellA</idShort><id>urn:a</id>
      <assetInformation><assetKind>Instance</assetKind><globalAssetId>urn:asset:a</globalAssetId></assetInformation>
      <submodels><reference><type>ModelReference</type><keys><key><type>Submodel</type><value>urn:sm:a</value></key></keys></reference></submodels>
    </assetAdministrationShell>
    <assetAdministrationShell>
      <idShort>ShellB</idShort><id>urn:b</id>
      <submodels><reference><type>ModelReference</type><keys><key><type>Submodel</type><value>urn:sm:b</value></key></keys></reference></submodels>
    </assetAdministrationShell>
  </assetAdministrationShells>
  <submodels>
    <submodel><idShort>Nameplate</idShort><id>urn:sm:a</id>
      <submodelElements>
        <multiLanguageProperty><idShort>ManufacturerProductDesignation</idShort>
          <semanticId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>0173-1#02-AAW338#001</value></key></keys></semanticId>
          <value><langStringTextType><language>de</language><text>Produkt A</text></langStringTextType><langStringTextType><language>en</language><text>Product A</text></langStringTextType></value>
        </multiLanguageProperty>
      </submodelElements>
    </submodel>
    <submodel><idShort>Nameplate</idShort><id>urn:sm:b</id>
      <submodelElements>
        <multiLanguageProperty><idShort>ManufacturerName</idShort>
          <semanticId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>0173-1#02-AAO677#002</value></key></keys></semanticId>
          <value><langStringTextType><language>de</language><text>Hersteller B</text></langStringTextType></value>
        </multiLanguageProperty>
      </submodelElements>
    </submodel>
  </submodels>
</environment>`;

describe('normalizePartPath', () => {
  it('normalises backslashes, percent escapes, dot segments and the leading slash', () => {
    expect(normalizePartPath('\\aasx\\Doc%20Folder\\a.pdf')).toBe('aasx/Doc Folder/a.pdf');
    expect(normalizePartPath('/aasx/./x/../y.xml')).toBe('aasx/y.xml');
  });
});

describe('real packages in public/aasx', () => {
  for (const exp of EXPECTED) {
    const path = fixture(exp.file);
    it.skipIf(!path)(`${exp.file}: id, idShort, product name, manufacturer, globalAssetId`, async () => {
      const result = await readAasxSummary(await openAsBlob(path!));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.shells).toHaveLength(1);
      expect(result.shells[0]).toEqual({
        id: exp.id,
        idShort: exp.idShort,
        productName: exp.productName,
        manufacturer: exp.manufacturer,
        globalAssetId: exp.globalAssetId,
      });
    });
  }

  const sew = fixture('26_SEW_KA47-DRN90M4.aasx');
  it.skipIf(!sew)('reads the 127 MB SEW package with less than 5 MB of slices (ranged reads)', async () => {
    const { blob, bytesRead } = countingBlob(await openAsBlob(sew!));
    expect(blob.size).toBeGreaterThan(100 * 1024 * 1024);
    const result = await readAasxSummary(blob);
    expect(result.ok).toBe(true);
    expect(bytesRead()).toBeLessThan(5 * 1024 * 1024);
  });

  const festo = fixture('23_Festo.aasx');
  it.skipIf(!festo)('reads a referenced PDF entry on demand', async () => {
    const pkg = await openAasxPackage(await openAsBlob(festo!));
    try {
      const pdf = await pkg.readEntry('/aasx/Documentation/DKI3WebDataSheet_0004.pdf');
      expect(pdf).not.toBeNull();
      const head = new Uint8Array(await pdf!.slice(0, 4).arrayBuffer());
      expect(String.fromCharCode(...head)).toBe('%PDF');
      expect(pdf!.type).toBe('application/pdf');
    } finally {
      await pkg.close();
    }
  });
});

describe('synthetic packages', () => {
  it('follows a www.-relationship', async () => {
    const blob = await makeZip({
      '_rels/.rels': ROOT_RELS('www.'),
      'aasx/_rels/aasx-origin.rels': ORIGIN_RELS('/aasx/env/x.xml', 'www.'),
      'aasx/aasx-origin': '',
      'aasx/env/x.xml': V3_TWO_SHELLS,
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/xml"/></Types>',
    });
    const r = await readAasxSummary(blob);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shells.map(s => s.id)).toEqual(['urn:a', 'urn:b']);
  });

  it('reads several shells per file, each with its own nameplate (en > de)', async () => {
    const blob = await makeZip({
      '_rels/.rels': ROOT_RELS(''),
      'aasx/_rels/aasx-origin.rels': ORIGIN_RELS('/aasx/env/x.xml'),
      'aasx/aasx-origin': '',
      'aasx/env/x.xml': V3_TWO_SHELLS,
    });
    const r = await readAasxSummary(blob);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shells[0]).toEqual({ id: 'urn:a', idShort: 'ShellA', globalAssetId: 'urn:asset:a', productName: 'Product A' });
    expect(r.shells[1]).toEqual({ id: 'urn:b', idShort: 'ShellB', manufacturer: 'Hersteller B' });
    // [Content_Types].xml missing — a warning, not a failure.
    expect(r.warnings.some(w => /Content_Types/.test(w))).toBe(true);
  });

  it('resolves backslash relationship targets', async () => {
    const blob = await makeZip({
      '_rels/.rels': ROOT_RELS(''),
      'aasx/_rels/aasx-origin.rels': ORIGIN_RELS('\\aasx\\env\\x.xml'),
      'aasx/aasx-origin': '',
      'aasx/env/x.xml': V3_TWO_SHELLS,
    });
    const r = await readAasxSummary(blob);
    expect(r.ok).toBe(true);
  });

  it('falls back to a *.aas.xml part without relationships, with a warning', async () => {
    const blob = await makeZip({ 'aasx/whatever/thing.aas.xml': V3_TWO_SHELLS });
    const r = await readAasxSummary(blob);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some(w => /No aas-spec relationship/.test(w))).toBe(true);
  });

  it('reads a JSON-serialised environment', async () => {
    const env = {
      assetAdministrationShells: [{
        modelType: 'AssetAdministrationShell', id: 'urn:json', idShort: 'JsonShell',
        assetInformation: { assetKind: 'Instance', globalAssetId: 'urn:asset:json' },
        submodels: [{ type: 'ModelReference', keys: [{ type: 'Submodel', value: 'urn:sm:json' }] }],
      }],
      submodels: [{
        modelType: 'Submodel', id: 'urn:sm:json', idShort: 'Nameplate',
        submodelElements: [{
          modelType: 'MultiLanguageProperty', idShort: 'ManufacturerProductDesignation',
          semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: '0173-1#02-AAW338#001' }] },
          value: [{ language: 'en', text: 'Json Product' }],
        }],
      }],
    };
    const blob = await makeZip({
      '_rels/.rels': ROOT_RELS(''),
      'aasx/_rels/aasx-origin.rels': ORIGIN_RELS('/aasx/env.json'),
      'aasx/aasx-origin': '',
      'aasx/env.json': '\uFEFF' + JSON.stringify(env),
    });
    const r = await readAasxSummary(blob);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shells[0]).toEqual({ id: 'urn:json', idShort: 'JsonShell', globalAssetId: 'urn:asset:json', productName: 'Json Product' });
  });

  it('returns an error object for a broken ZIP instead of throwing', async () => {
    const r = await readAasxSummary(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/AASX|ZIP|zip/);
  });

  it('returns an error object for a ZIP without any AAS', async () => {
    const r = await readAasxSummary(await makeZip({ 'readme.txt': 'nothing here' }));
    expect(r).toEqual({ ok: false, error: 'No AAS spec part found in package' });
  });
});
