// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDeliveryConfigs, loadTierManifest, renderFeatureMatrix } from './_workspace-lib.mjs';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(coreRoot, '../realvirtual-WebViewer-Private~');

export function generateFeatureMatrix(options = {}) {
  const root = resolve(options.privateRoot ?? privateRoot);
  const manifest = loadTierManifest(root);
  // The file name is no longer the project key (§2.10): a config may name several
  // projects and be called after the customer. Enumerating the folder here and
  // slicing ".json" off each name assumed the opposite and produced a "config not
  // found" for every converted file.
  const deliveries = listDeliveryConfigs(root, manifest);
  const markdown = renderFeatureMatrix(manifest, deliveries, options.projectKey ?? null);
  if (options.output) writeFileSync(resolve(options.output), markdown);
  return markdown;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const markdown = generateFeatureMatrix({ output });
  if (!output) process.stdout.write(markdown);
}
