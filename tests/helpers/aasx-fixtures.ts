// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aasx-fixtures — synthetic AASX packages for the plan-596 tests.
 *
 * Built with zip.js in the test itself, so no customer file is ever copied or
 * modified. A package is described as a list of shells, each with an optional
 * nameplate, technical-data properties and PDF documents; the helper writes a
 * proper OPC structure (`_rels/.rels` → aasx-origin → aas-spec) around it, as
 * V3 XML or V3 JSON.
 */

import { loadZipJs } from '../../src/core/aas/rv-aasx-package';

export interface FixtureDoc {
  title: string;
  /** Path inside the package, e.g. `/aasx/docs/a.pdf`. */
  path: string;
  /** Bytes of the PDF; defaults to a tiny `%PDF` stub carrying the title. */
  bytes?: Uint8Array;
}

export interface FixtureShell {
  id: string;
  idShort: string;
  productName?: string;
  manufacturer?: string;
  technical?: Record<string, string>;
  docs?: FixtureDoc[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function smId(shell: FixtureShell, kind: string): string {
  return `${shell.id}/sm/${kind}`;
}

function xmlEnvironment(shells: FixtureShell[]): string {
  const shellXml = shells.map(s => `
    <assetAdministrationShell>
      <idShort>${esc(s.idShort)}</idShort><id>${esc(s.id)}</id>
      <assetInformation><assetKind>Instance</assetKind><globalAssetId>${esc(s.id)}/asset</globalAssetId></assetInformation>
      <submodels>
        ${['np', 'td', 'doc'].map(k => `<reference><type>ModelReference</type><keys><key><type>Submodel</type><value>${esc(smId(s, k))}</value></key></keys></reference>`).join('')}
      </submodels>
    </assetAdministrationShell>`).join('');
  const sms = shells.map(s => `
    <submodel><idShort>Nameplate</idShort><id>${esc(smId(s, 'np'))}</id><submodelElements>
      ${s.manufacturer ? `<multiLanguageProperty><idShort>ManufacturerName</idShort><semanticId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>0173-1#02-AAO677#002</value></key></keys></semanticId><value><langStringTextType><language>en</language><text>${esc(s.manufacturer)}</text></langStringTextType></value></multiLanguageProperty>` : ''}
      ${s.productName ? `<multiLanguageProperty><idShort>ManufacturerProductDesignation</idShort><semanticId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>0173-1#02-AAW338#001</value></key></keys></semanticId><value><langStringTextType><language>en</language><text>${esc(s.productName)}</text></langStringTextType></value></multiLanguageProperty>` : ''}
    </submodelElements></submodel>
    <submodel><idShort>TechnicalData</idShort><id>${esc(smId(s, 'td'))}</id><submodelElements>
      ${Object.entries(s.technical ?? {}).map(([k, v]) => `<property><idShort>${esc(k)}</idShort><valueType>xs:string</valueType><value>${esc(v)}</value></property>`).join('')}
    </submodelElements></submodel>
    <submodel><idShort>HandoverDocumentation</idShort><id>${esc(smId(s, 'doc'))}</id><submodelElements>
      ${(s.docs ?? []).map((d, i) => `<submodelElementCollection><idShort>Document${i}</idShort><value>
        <property><idShort>Title</idShort><valueType>xs:string</valueType><value>${esc(d.title)}</value></property>
        <file><idShort>File</idShort><contentType>application/pdf</contentType><value>${esc(d.path)}</value></file>
      </value></submodelElementCollection>`).join('')}
    </submodelElements></submodel>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<environment xmlns="https://admin-shell.io/aas/3/0">
  <assetAdministrationShells>${shellXml}</assetAdministrationShells>
  <submodels>${sms}</submodels>
</environment>`;
}

function jsonEnvironment(shells: FixtureShell[]): string {
  const ref = (v: string) => ({ type: 'ModelReference', keys: [{ type: 'Submodel', value: v }] });
  const sem = (v: string) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: v }] });
  return JSON.stringify({
    assetAdministrationShells: shells.map(s => ({
      modelType: 'AssetAdministrationShell', id: s.id, idShort: s.idShort,
      assetInformation: { assetKind: 'Instance', globalAssetId: `${s.id}/asset` },
      submodels: ['np', 'td', 'doc'].map(k => ref(smId(s, k))),
    })),
    submodels: shells.flatMap(s => [
      {
        modelType: 'Submodel', id: smId(s, 'np'), idShort: 'Nameplate',
        submodelElements: [
          ...(s.manufacturer ? [{ modelType: 'MultiLanguageProperty', idShort: 'ManufacturerName', semanticId: sem('0173-1#02-AAO677#002'), value: [{ language: 'en', text: s.manufacturer }] }] : []),
          ...(s.productName ? [{ modelType: 'MultiLanguageProperty', idShort: 'ManufacturerProductDesignation', semanticId: sem('0173-1#02-AAW338#001'), value: [{ language: 'en', text: s.productName }] }] : []),
        ],
      },
      {
        modelType: 'Submodel', id: smId(s, 'td'), idShort: 'TechnicalData',
        submodelElements: Object.entries(s.technical ?? {}).map(([k, v]) => ({ modelType: 'Property', idShort: k, valueType: 'xs:string', value: v })),
      },
      {
        modelType: 'Submodel', id: smId(s, 'doc'), idShort: 'HandoverDocumentation',
        submodelElements: (s.docs ?? []).map((d, i) => ({
          modelType: 'SubmodelElementCollection', idShort: `Document${i}`,
          value: [
            { modelType: 'Property', idShort: 'Title', valueType: 'xs:string', value: d.title },
            { modelType: 'File', idShort: 'File', contentType: 'application/pdf', value: d.path },
          ],
        })),
      },
    ]),
  });
}

/** Build an AASX package (OPC + V3 XML or JSON spec part). */
export async function makeAasx(shells: FixtureShell[], opts: { format?: 'xml' | 'json' } = {}): Promise<Uint8Array> {
  const zipjs = await loadZipJs();
  const format = opts.format ?? 'xml';
  const specPath = format === 'json' ? 'aasx/env/env.aas.json' : 'aasx/env/env.aas.xml';
  const writer = new zipjs.ZipWriter(new zipjs.Uint8ArrayWriter());
  const add = (name: string, content: string | Uint8Array) => writer.add(
    name,
    typeof content === 'string' ? new zipjs.TextReader(content) : new zipjs.Uint8ArrayReader(content),
  );
  await add('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="text/xml"/><Default Extension="json" ContentType="application/json"/><Default Extension="pdf" ContentType="application/pdf"/></Types>');
  await add('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin" Id="R1"/></Relationships>');
  await add('aasx/aasx-origin', 'Intentionally empty.');
  await add('aasx/_rels/aasx-origin.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://admin-shell.io/aasx/relationships/aas-spec" Target="/${specPath}" Id="R2"/></Relationships>`);
  await add(specPath, format === 'json' ? jsonEnvironment(shells) : xmlEnvironment(shells));
  for (const s of shells) {
    for (const d of s.docs ?? []) {
      await add(d.path.replace(/^\//, ''), d.bytes ?? new TextEncoder().encode(`%PDF-1.4 ${d.title}`));
    }
  }
  return writer.close();
}

/** A `File` with an explicit name / lastModified (for stat-diff tests). */
export function aasxFile(bytes: Uint8Array, name: string, lastModified = 1000): File {
  return new File([bytes as unknown as BlobPart], name, { type: 'application/zip', lastModified });
}
