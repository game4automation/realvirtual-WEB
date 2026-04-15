// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseAasXml,
  parseDocuments,
  cleanLabel,
  loadIndex,
  loadAasxById,
  loadAasx,
  extractFileBlob,
  resetIndex,
  resetCache,
  type AasParsedData,
  type AasDocument,
} from '../src/plugins/aas-link-parser';

// ─── Test XML Fixtures ──────────────────────────────────────────────────

/** Minimal AAS V2 XML with Nameplate and TechnicalData submodels. */
const FESTO_XML = `<?xml version="1.0"?>
<aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0">
  <aas:assetAdministrationShells>
    <aas:assetAdministrationShell>
      <aas:idShort>Festo_EPCC-BS-32-100-3P-A</aas:idShort>
      <aas:identification idType="IRI">http://smart.festo.com/aas/99920200623113326000013225</aas:identification>
    </aas:assetAdministrationShell>
  </aas:assetAdministrationShells>
  <aas:submodels>
    <aas:submodel>
      <aas:idShort>Nameplate</aas:idShort>
      <aas:submodelElements>
        <aas:submodelElement>
          <aas:property>
            <aas:idShort>ManufacturerName</aas:idShort>
            <aas:value>Festo SE &amp; Co. KG</aas:value>
          </aas:property>
        </aas:submodelElement>
        <aas:submodelElement>
          <aas:property>
            <aas:idShort>ManufacturerProductDesignation</aas:idShort>
            <aas:value>Electric cylinder with spindle drive</aas:value>
          </aas:property>
        </aas:submodelElement>
        <aas:submodelElement>
          <aas:property>
            <aas:idShort>SerialNumber</aas:idShort>
            <aas:value>SN-12345</aas:value>
          </aas:property>
        </aas:submodelElement>
      </aas:submodelElements>
    </aas:submodel>
    <aas:submodel>
      <aas:idShort>TechnicalData</aas:idShort>
      <aas:submodelElements>
        <aas:submodelElement>
          <aas:property>
            <aas:idShort>Stroke</aas:idShort>
            <aas:value>100 mm</aas:value>
          </aas:property>
        </aas:submodelElement>
        <aas:submodelElement>
          <aas:property>
            <aas:idShort>Max__speed</aas:idShort>
            <aas:value>0.188 m/s</aas:value>
          </aas:property>
        </aas:submodelElement>
        <aas:submodelElement>
          <aas:property>
            <aas:idShort>Max_force</aas:idShort>
            <aas:value>150 N</aas:value>
          </aas:property>
        </aas:submodelElement>
      </aas:submodelElements>
    </aas:submodel>
  </aas:submodels>
</aas:aasenv>`;

/** AAS XML without namespace prefix (V3 style). */
const NO_PREFIX_XML = `<?xml version="1.0"?>
<environment>
  <assetAdministrationShells>
    <assetAdministrationShell>
      <idShort>TestShell</idShort>
      <id>urn:example:aas:test-001</id>
    </assetAdministrationShell>
  </assetAdministrationShells>
  <submodels>
    <submodel>
      <idShort>Nameplate</idShort>
      <submodelElements>
        <submodelElement>
          <property>
            <idShort>ManufacturerName</idShort>
            <value>TestCorp</value>
          </property>
        </submodelElement>
      </submodelElements>
    </submodel>
  </submodels>
</environment>`;

/** XML with nested SubmodelElementCollection. */
const NESTED_XML = `<?xml version="1.0"?>
<aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0">
  <aas:assetAdministrationShells>
    <aas:assetAdministrationShell>
      <aas:idShort>NestedTest</aas:idShort>
      <aas:identification idType="IRI">urn:test:nested</aas:identification>
    </aas:assetAdministrationShell>
  </aas:assetAdministrationShells>
  <aas:submodels>
    <aas:submodel>
      <aas:idShort>Nameplate</aas:idShort>
      <aas:submodelElements>
        <aas:submodelElement>
          <aas:property>
            <aas:idShort>ManufacturerName</aas:idShort>
            <aas:value>ACME</aas:value>
          </aas:property>
        </aas:submodelElement>
        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>PhysicalAddress</aas:idShort>
            <aas:value>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>CountryCode</aas:idShort>
                  <aas:value>DE</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>CityTown</aas:idShort>
                  <aas:value>Berlin</aas:value>
                </aas:property>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>
      </aas:submodelElements>
    </aas:submodel>
  </aas:submodels>
</aas:aasenv>`;

// ─── Tests ──────────────────────────────────────────────────────────────

describe('parseAasXml', () => {
  it('should extract AAS ID and idShort from V2 namespaced XML', () => {
    const data = parseAasXml(FESTO_XML);
    expect(data.aasId).toBe('http://smart.festo.com/aas/99920200623113326000013225');
    expect(data.idShort).toBe('Festo_EPCC-BS-32-100-3P-A');
  });

  it('should extract Nameplate properties', () => {
    const data = parseAasXml(FESTO_XML);
    expect(data.nameplate.length).toBe(3);
    expect(data.nameplate[0]).toEqual({ label: 'Manufacturer Name', value: 'Festo SE & Co. KG' });
    expect(data.nameplate[1]).toEqual({ label: 'Manufacturer Product Designation', value: 'Electric cylinder with spindle drive' });
    expect(data.nameplate[2]).toEqual({ label: 'Serial Number', value: 'SN-12345' });
  });

  it('should extract TechnicalData properties', () => {
    const data = parseAasXml(FESTO_XML);
    expect(data.technicalData.length).toBe(3);
    expect(data.technicalData[0]).toEqual({ label: 'Stroke', value: '100 mm' });
    expect(data.technicalData[1]).toEqual({ label: 'Max speed', value: '0.188 m/s' });
    expect(data.technicalData[2]).toEqual({ label: 'Max force', value: '150 N' });
  });

  it('should parse XML without namespace prefix (V3 style)', () => {
    const data = parseAasXml(NO_PREFIX_XML);
    expect(data.aasId).toBe('urn:example:aas:test-001');
    expect(data.idShort).toBe('TestShell');
    expect(data.nameplate.length).toBe(1);
    expect(data.nameplate[0]).toEqual({ label: 'Manufacturer Name', value: 'TestCorp' });
  });

  it('should extract properties from nested SubmodelElementCollections', () => {
    const data = parseAasXml(NESTED_XML);
    expect(data.nameplate.length).toBe(3);
    expect(data.nameplate[0]).toEqual({ label: 'Manufacturer Name', value: 'ACME' });
    // Nested properties from PhysicalAddress collection
    expect(data.nameplate[1]).toEqual({ label: 'Country Code', value: 'DE' });
    expect(data.nameplate[2]).toEqual({ label: 'City Town', value: 'Berlin' });
  });

  it('should throw on malformed XML', () => {
    expect(() => parseAasXml('<not valid <<< xml')).toThrow(/XML parse error/);
  });

  it('should return empty arrays for XML with no submodels', () => {
    const xml = `<?xml version="1.0"?>
    <aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0">
      <aas:assetAdministrationShells>
        <aas:assetAdministrationShell>
          <aas:idShort>EmptyShell</aas:idShort>
          <aas:identification>urn:empty</aas:identification>
        </aas:assetAdministrationShell>
      </aas:assetAdministrationShells>
    </aas:aasenv>`;
    const data = parseAasXml(xml);
    expect(data.aasId).toBe('urn:empty');
    expect(data.nameplate).toEqual([]);
    expect(data.technicalData).toEqual([]);
    expect(data.documents).toEqual([]);
  });

  it('should include documents field in parsed result', () => {
    const data = parseAasXml(FESTO_XML);
    expect(data.documents).toBeDefined();
    expect(Array.isArray(data.documents)).toBe(true);
  });
});

describe('cleanLabel', () => {
  it('should replace double underscores with space', () => {
    expect(cleanLabel('Max__speed')).toBe('Max speed');
  });

  it('should replace single underscore with space', () => {
    expect(cleanLabel('Max_force')).toBe('Max force');
  });

  it('should insert space before camelCase capitals', () => {
    expect(cleanLabel('ManufacturerName')).toBe('Manufacturer Name');
  });

  it('should handle mixed patterns', () => {
    expect(cleanLabel('Serial_Number')).toBe('Serial Number');
  });

  it('should trim whitespace', () => {
    expect(cleanLabel('  Stroke  ')).toBe('Stroke');
  });

  it('should collapse multiple spaces', () => {
    expect(cleanLabel('Too___many___underscores')).toBe('Too many underscores');
  });
});

describe('loadIndex', () => {
  beforeEach(() => {
    resetIndex();
    resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch and cache index.json', async () => {
    const mockIndex = {
      'urn:test:001': { file: 'test.aasx', idShort: 'TestProduct' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockIndex), { status: 200 }),
    );

    const index = await loadIndex();
    expect(index).toEqual(mockIndex);

    // Second call should NOT fetch again (cached)
    const index2 = await loadIndex();
    expect(index2).toEqual(mockIndex);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should return empty object on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    const index = await loadIndex();
    expect(index).toEqual({});
  });

  it('should return empty object on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const index = await loadIndex();
    expect(index).toEqual({});
  });
});

describe('loadAasxById', () => {
  beforeEach(() => {
    resetIndex();
    resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should throw when AAS ID is not in index', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(loadAasxById('urn:nonexistent')).rejects.toThrow('AAS ID not found in index');
  });
});

describe('loadAasx caching', () => {
  beforeEach(() => {
    resetIndex();
    resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should deduplicate concurrent requests for the same file', async () => {
    // Create a minimal valid ZIP with an .aas.xml
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('content.aas.xml', FESTO_XML);
    const zipBlob = await zip.generateAsync({ type: 'arraybuffer' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(zipBlob, { status: 200 }),
    );

    // Fire two concurrent requests
    const [r1, r2] = await Promise.all([
      loadAasx('test.aasx'),
      loadAasx('test.aasx'),
    ]);

    expect(r1).toBe(r2); // Same promise, same result object
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should delete cache entry on rejection and allow retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce((() => {
        // Can't easily create a valid ZIP synchronously, so just fail differently
        return new Response(null, { status: 500 });
      })());

    await expect(loadAasx('failing.aasx')).rejects.toThrow('Failed to load');

    // Second call should attempt fetch again (cache was cleared)
    await expect(loadAasx('failing.aasx')).rejects.toThrow('Failed to load');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

// ─── Document Parsing Tests ────────────────────────────────────────────

/** XML with Documentation submodel containing PDF files (Festo style). */
const DOC_XML_V2 = `<?xml version="1.0"?>
<aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0">
  <aas:assetAdministrationShells>
    <aas:assetAdministrationShell>
      <aas:idShort>DocTest</aas:idShort>
      <aas:identification>urn:test:docs</aas:identification>
    </aas:assetAdministrationShell>
  </aas:assetAdministrationShells>
  <aas:submodels>
    <aas:submodel>
      <aas:idShort>Documentation</aas:idShort>
      <aas:submodelElements>
        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>Document01</aas:idShort>
            <aas:value>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_Title</aas:idShort>
                  <aas:value>Operating Instructions</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:file>
                  <aas:idShort>File</aas:idShort>
                  <aas:mimeType>application/pdf</aas:mimeType>
                  <aas:value>/aasx/Documentation/manual.pdf</aas:value>
                </aas:file>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>
        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>Document02</aas:idShort>
            <aas:value>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_Title</aas:idShort>
                  <aas:value>Safety Certificate</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:file>
                  <aas:idShort>File</aas:idShort>
                  <aas:mimeType>application/pdf</aas:mimeType>
                  <aas:value>/aasx/Documentation/safety.pdf</aas:value>
                </aas:file>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>
      </aas:submodelElements>
    </aas:submodel>
  </aas:submodels>
</aas:aasenv>`;

/** XML with mixed file types (PDF + STL) — only PDFs should be included. */
const DOC_MIXED_XML = `<?xml version="1.0"?>
<aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0">
  <aas:assetAdministrationShells>
    <aas:assetAdministrationShell>
      <aas:idShort>MixedDocs</aas:idShort>
      <aas:identification>urn:test:mixed</aas:identification>
    </aas:assetAdministrationShell>
  </aas:assetAdministrationShells>
  <aas:submodels>
    <aas:submodel>
      <aas:idShort>Documentation</aas:idShort>
      <aas:submodelElements>
        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>Document01</aas:idShort>
            <aas:value>
              <aas:submodelElement>
                <aas:file>
                  <aas:idShort>File</aas:idShort>
                  <aas:mimeType>model/stl</aas:mimeType>
                  <aas:value>/aasx/3dmodel/part.stl</aas:value>
                </aas:file>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>
        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>Document02</aas:idShort>
            <aas:value>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_Title</aas:idShort>
                  <aas:value>Datasheet</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:file>
                  <aas:idShort>File</aas:idShort>
                  <aas:mimeType>application/pdf</aas:mimeType>
                  <aas:value>/aasx/Documentation/datasheet.pdf</aas:value>
                </aas:file>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>
      </aas:submodelElements>
    </aas:submodel>
  </aas:submodels>
</aas:aasenv>`;

/** V3-style XML (no namespace prefix) with Documentation. */
const DOC_XML_V3 = `<?xml version="1.0"?>
<environment>
  <assetAdministrationShells>
    <assetAdministrationShell>
      <idShort>V3DocTest</idShort>
      <id>urn:test:v3docs</id>
    </assetAdministrationShell>
  </assetAdministrationShells>
  <submodels>
    <submodel>
      <idShort>Documentation</idShort>
      <submodelElements>
        <submodelElement>
          <submodelElementCollection>
            <idShort>Document01</idShort>
            <value>
              <submodelElement>
                <property>
                  <idShort>Title</idShort>
                  <value>Quick Start Guide</value>
                </property>
              </submodelElement>
              <submodelElement>
                <file>
                  <idShort>File</idShort>
                  <mimeType>application/pdf</mimeType>
                  <value>/aasx/docs/quickstart.pdf</value>
                </file>
              </submodelElement>
            </value>
          </submodelElementCollection>
        </submodelElement>
      </submodelElements>
    </submodel>
  </submodels>
</environment>`;

/** XML with document without VDI2770_Title — should fallback to filename. */
const DOC_NO_TITLE_XML = `<?xml version="1.0"?>
<aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0">
  <aas:assetAdministrationShells>
    <aas:assetAdministrationShell>
      <aas:idShort>NoTitle</aas:idShort>
      <aas:identification>urn:test:notitle</aas:identification>
    </aas:assetAdministrationShell>
  </aas:assetAdministrationShells>
  <aas:submodels>
    <aas:submodel>
      <aas:idShort>Documentation</aas:idShort>
      <aas:submodelElements>
        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>Document01</aas:idShort>
            <aas:value>
              <aas:submodelElement>
                <aas:file>
                  <aas:idShort>File</aas:idShort>
                  <aas:mimeType>application/pdf</aas:mimeType>
                  <aas:value>/aasx/Documentation/maintenance-guide.pdf</aas:value>
                </aas:file>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>
      </aas:submodelElements>
    </aas:submodel>
  </aas:submodels>
</aas:aasenv>`;

/** XML with backslash path separators. */
const DOC_BACKSLASH_XML = `<?xml version="1.0"?>
<aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0">
  <aas:assetAdministrationShells>
    <aas:assetAdministrationShell>
      <aas:idShort>BackslashTest</aas:idShort>
      <aas:identification>urn:test:backslash</aas:identification>
    </aas:assetAdministrationShell>
  </aas:assetAdministrationShells>
  <aas:submodels>
    <aas:submodel>
      <aas:idShort>DocumentCollection</aas:idShort>
      <aas:submodelElements>
        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>Doc01</aas:idShort>
            <aas:value>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_Title</aas:idShort>
                  <aas:value>Manual</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:file>
                  <aas:idShort>File</aas:idShort>
                  <aas:mimeType>application/pdf</aas:mimeType>
                  <aas:value>\\aasx\\Documentation\\manual.pdf</aas:value>
                </aas:file>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>
      </aas:submodelElements>
    </aas:submodel>
  </aas:submodels>
</aas:aasenv>`;

describe('parseDocuments', () => {
  it('should extract PDF documents from V2 Documentation submodel', () => {
    const data = parseAasXml(DOC_XML_V2);
    expect(data.documents).toHaveLength(2);
    expect(data.documents[0]).toEqual({
      title: 'Operating Instructions',
      mimeType: 'application/pdf',
      zipPath: 'aasx/Documentation/manual.pdf',
    });
    expect(data.documents[1]).toEqual({
      title: 'Safety Certificate',
      mimeType: 'application/pdf',
      zipPath: 'aasx/Documentation/safety.pdf',
    });
  });

  it('should filter out non-PDF files', () => {
    const data = parseAasXml(DOC_MIXED_XML);
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].title).toBe('Datasheet');
    expect(data.documents[0].mimeType).toBe('application/pdf');
  });

  it('should parse V3-style XML without namespace prefix', () => {
    const data = parseAasXml(DOC_XML_V3);
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0]).toEqual({
      title: 'Quick Start Guide',
      mimeType: 'application/pdf',
      zipPath: 'aasx/docs/quickstart.pdf',
    });
  });

  it('should fallback to filename when VDI2770_Title is missing', () => {
    const data = parseAasXml(DOC_NO_TITLE_XML);
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].title).toBe('maintenance-guide');
  });

  it('should normalize backslash path separators', () => {
    const data = parseAasXml(DOC_BACKSLASH_XML);
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].zipPath).toBe('aasx/Documentation/manual.pdf');
    expect(data.documents[0].zipPath).not.toContain('\\');
  });

  it('should match DocumentCollection as idShort variant', () => {
    const data = parseAasXml(DOC_BACKSLASH_XML);
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].title).toBe('Manual');
  });

  it('should return empty array when no Documentation submodel exists', () => {
    const data = parseAasXml(FESTO_XML);
    expect(data.documents).toEqual([]);
  });

  it('should strip leading slash from zipPath', () => {
    const data = parseAasXml(DOC_XML_V2);
    for (const doc of data.documents) {
      expect(doc.zipPath).not.toMatch(/^\//);
    }
  });
});

describe('extractFileBlob', () => {
  beforeEach(() => {
    resetIndex();
    resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should throw when AAS ID is not in index', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(extractFileBlob('urn:nonexistent', 'some/path.pdf')).rejects.toThrow('AAS ID not found in index');
  });

  it('should extract a PDF file and return a blob URL', async () => {
    const mockIndex = {
      'urn:test:001': { file: 'test.aasx', idShort: 'TestProduct' },
    };

    // Create a ZIP with an .aas.xml and a PDF file
    const JSZipLib = (await import('jszip')).default;
    const zip = new JSZipLib();
    zip.file('content.aas.xml', FESTO_XML);
    zip.file('aasx/Documentation/manual.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46])); // %PDF header
    const zipBlob = await zip.generateAsync({ type: 'arraybuffer' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockIndex), { status: 200 }))
      .mockResolvedValueOnce(new Response(zipBlob, { status: 200 }));

    // Mock URL.createObjectURL
    const mockUrl = 'blob:test-url-12345';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockUrl);

    const url = await extractFileBlob('urn:test:001', 'aasx/Documentation/manual.pdf');
    expect(url).toBe(mockUrl);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('should try aasx/ prefix when direct path not found', async () => {
    const mockIndex = {
      'urn:test:001': { file: 'test.aasx', idShort: 'TestProduct' },
    };

    const JSZipLib = (await import('jszip')).default;
    const zip = new JSZipLib();
    zip.file('content.aas.xml', FESTO_XML);
    zip.file('aasx/Documentation/manual.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const zipBlob = await zip.generateAsync({ type: 'arraybuffer' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockIndex), { status: 200 }))
      .mockResolvedValueOnce(new Response(zipBlob, { status: 200 }));

    const mockUrl = 'blob:prefix-test';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockUrl);

    // Request without aasx/ prefix — should still find the file
    const url = await extractFileBlob('urn:test:001', 'Documentation/manual.pdf');
    expect(url).toBe(mockUrl);
  });

  it('should throw when file not found in ZIP', async () => {
    const mockIndex = {
      'urn:test:001': { file: 'test.aasx', idShort: 'TestProduct' },
    };

    const JSZipLib = (await import('jszip')).default;
    const zip = new JSZipLib();
    zip.file('content.aas.xml', FESTO_XML);
    const zipBlob = await zip.generateAsync({ type: 'arraybuffer' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockIndex), { status: 200 }))
      .mockResolvedValueOnce(new Response(zipBlob, { status: 200 }));

    await expect(extractFileBlob('urn:test:001', 'nonexistent/file.pdf')).rejects.toThrow('File not found in AASX');
  });
});
