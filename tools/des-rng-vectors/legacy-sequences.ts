// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { writeFileSync } from 'node:fs';
import { legacySequences } from '../realvirtual-WebViewer~/tests/des/rng-v2-legacy-harness';
const provenance = {
  source: 'Unchanged production code before plan-2060 implementation; base origin/main 7dccdc0e',
  command: 'cd realvirtual-WebViewer~ && node ../vectors/run-legacy-node.mjs',
  execution: 'Node synchronous TypeScript loader fallback: vite-node/tsx absent, Vite esbuild spawn EPERM',
  harness: 'rng-v2-legacy-harness.ts: real Station/Downtime scene binding and real three-output TaktSource, one RNG per consumer',
};
writeFileSync('tests/des/fixtures/rng-v2/legacy-sequences.json', JSON.stringify({ provenance, ...legacySequences() }, null, 2) + '\n');
