// Generate only takt; run with LEGACY_SOURCE_REPO pointing at unchanged 7dccdc0e.
import { readFileSync, writeFileSync } from 'node:fs';
import { legacyTaktSequence } from '../realvirtual-WebViewer~/tests/des/rng-v2-legacy-harness';
const target = new URL('../realvirtual-WebViewer~/tests/des/fixtures/rng-v2/legacy-sequences.json', import.meta.url);
const original = readFileSync(target, 'utf8');
const start = original.indexOf('  "takt": {');
if (start < 0) throw new Error('Missing takt section');
const takt = JSON.stringify(legacyTaktSequence(), null, 2).replaceAll('\n', '\n  ');
writeFileSync(target, original.slice(0, start) + '  "takt": ' + takt + '\n}\n');
console.log('Generated takt from ' + process.env.LEGACY_SOURCE_REPO);
