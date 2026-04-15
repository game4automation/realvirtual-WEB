// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-aasx-index.mjs — Scans public/aasx/*.aasx, extracts AAS IDs from
 * the embedded XML, and writes public/aasx/index.json.
 *
 * Usage:
 *   node scripts/build-aasx-index.mjs
 *
 * The generated index maps AAS identification URIs to { file, idShort }.
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AASX_DIR = join(__dirname, '..', 'public', 'aasx');

export async function buildAasxIndex() {
  let files;
  try {
    files = (await readdir(AASX_DIR)).filter(f => f.endsWith('.aasx'));
  } catch {
    console.warn('aasx directory not found, skipping index generation');
    return {};
  }

  if (files.length === 0) {
    console.warn('No .aasx files found in public/aasx/');
    return {};
  }

  const index = {};

  for (const file of files) {
    try {
      const buf = await readFile(join(AASX_DIR, file));
      const zip = await JSZip.loadAsync(buf);

      // Find the .aas.xml or any XML file that contains AAS content
      const xmlEntry = Object.keys(zip.files).find(
        f => f.endsWith('.aas.xml') || (f.endsWith('.xml') && !f.startsWith('['))
      );
      if (!xmlEntry) {
        console.warn(`  ${file}: no XML found, skipping`);
        continue;
      }

      const xml = await zip.files[xmlEntry].async('text');

      // Extract AAS identification — namespace-agnostic (handles aas: prefix or none)
      // V2: <aas:identification idType="IRI">...</aas:identification>
      // V3: <id>...</id>
      const idMatch = xml.match(/<(?:\w+:)?identification[^>]*>([^<]+)<\/(?:\w+:)?identification>/i)
        || xml.match(/<(?:\w+:)?id>([^<]+)<\/(?:\w+:)?id>/i);

      // Extract idShort from the first assetAdministrationShell
      const idShortMatch = xml.match(/<(?:\w+:)?idShort>([^<]+)<\/(?:\w+:)?idShort>/i);

      if (idMatch) {
        const aasId = idMatch[1].trim();
        index[aasId] = {
          file,
          idShort: idShortMatch?.[1]?.trim() ?? file.replace('.aasx', ''),
        };
        console.log(`  ${file}: ${aasId}`);
      } else {
        console.warn(`  ${file}: no AAS ID found, skipping`);
      }
    } catch (err) {
      console.warn(`  ${file}: error reading — ${err.message}`);
    }
  }

  const outPath = join(AASX_DIR, 'index.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(index, null, 2));
  console.log(`aasx/index.json: ${Object.keys(index).length} entries`);

  return index;
}

// Run when executed directly
buildAasxIndex();
