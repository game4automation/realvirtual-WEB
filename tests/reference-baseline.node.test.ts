// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0 — the checked-in reference baseline
 * (`tests/fixtures/reference-baseline.json`, written by
 * `node scripts/rv-reference-baseline.mjs --out tests/fixtures/reference-baseline.json`)
 * still describes the GLBs on disk.
 *
 * For every snapshot GLB present here (public always; private when the sibling
 * repo is checked out) the analysis is recomputed and compared: reference
 * counts per stage / migration route, the digest over every single reference,
 * the non-trivial entries and the seed spike. Files above 30 MB (the large
 * customer models) are compared only with `RV_REFERENCE_BASELINE_FULL=1` — their
 * JSON chunk alone costs seconds. A GLB git TRACKS that the snapshot does not
 * know fails: regenerate the snapshot and review the diff. Untracked files (a
 * local `*-draft_*.scene.glb`, an editor save, a downloaded model) are none of
 * the snapshot's business — the same `listBaselineFiles` rule the generator uses.
 *
 * Private entries other than the pinned ones live in the private sibling
 * (`tests/fixtures/reference-baseline.private.json`, see `splitSnapshot` in the
 * generator) and are merged here when it is checked out.
 *
 * Phase 1 turns this into its acceptance (9.13): the viewer's migration must
 * land every reference where `via` / `target` say.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlbJson, analyseGlb, listBaselineFiles, labelOf, PUBLIC_PINNED_LABELS } from '../scripts/rv-reference-baseline.mjs';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ROOT = resolve(WEB_ROOT, '..', 'realvirtual-WebViewer-Private~');
const PUBLIC_SNAPSHOT = JSON.parse(readFileSync(resolve(WEB_ROOT, 'tests/fixtures/reference-baseline.json'), 'utf8'));
const PRIVATE_SNAPSHOT_PATH = resolve(PRIVATE_ROOT, 'tests/fixtures/reference-baseline.private.json');
const PRIVATE_SNAPSHOT = existsSync(PRIVATE_SNAPSHOT_PATH) ? JSON.parse(readFileSync(PRIVATE_SNAPSHOT_PATH, 'utf8')) : { glbs: {} };
const SNAPSHOT = { ...PUBLIC_SNAPSHOT, glbs: { ...PRIVATE_SNAPSHOT.glbs, ...PUBLIC_SNAPSHOT.glbs } };
const FULL = process.env.RV_REFERENCE_BASELINE_FULL === '1';
const BIG = 30 * 1024 * 1024;

function fileOf(label: string): string {
  if (label.startsWith('private:')) return resolve(PRIVATE_ROOT, label.slice('private:'.length));
  return resolve(WEB_ROOT, label.slice('public:'.length));
}

/**
 * Labels of every TRACKED GLB below the generator's default roots — the script's
 * own file list and naming (`listBaselineFiles` + `labelOf`); the private root
 * simply yields nothing when the sibling repo is not checked out.
 */
function listGlbLabels(): string[] {
  return [resolve(WEB_ROOT, 'public'), resolve(PRIVATE_ROOT, 'projects')]
    .flatMap((root) => listBaselineFiles(root, '.glb'))
    .map(labelOf)
    .sort();
}

const labels = Object.keys(SNAPSHOT.glbs as Record<string, unknown>).filter((l) => {
  const f = fileOf(l);
  return existsSync(f) && (FULL || statSync(f).size <= BIG);
});

describe('plan-769 Phase 0 — reference baseline snapshot', () => {
  it('covers at least the public GLBs', () => {
    expect(labels.some((l) => l.startsWith('public:'))).toBe(true);
  });

  it.each(labels)('%s matches the snapshot', (label) => {
    const want = SNAPSHOT.glbs[label];
    const { json, jsonSha1 } = readGlbJson(fileOf(label));
    expect(jsonSha1, 'the file changed — regenerate the snapshot and review the diff').toBe(want.jsonSha1);
    const got = analyseGlb(json, { entries: SNAPSHOT.entries });
    expect(got.refs).toEqual(want.refs);
    expect(got.refsDigest).toBe(want.refsDigest);
    expect(got.entries).toEqual(want.entries);
    const { seedMs: _got, ...seedGot } = got.seed;
    const { seedMs: _want, ...seedWant } = want.seed;
    expect(seedGot).toEqual(seedWant);
    expect(got.overrides).toEqual(want.overrides);
  });

  it('the public fixture carries no withheld private entry (customer project names stay private)', () => {
    const leaked = Object.keys(PUBLIC_SNAPSHOT.glbs as Record<string, unknown>)
      .filter((l) => !l.startsWith('public:') && !PUBLIC_PINNED_LABELS.includes(l));
    expect(leaked, 'regenerate with scripts/rv-reference-baseline.mjs --out (it splits the snapshot)').toEqual([]);
    expect(Object.keys(PUBLIC_SNAPSHOT.perCustomer ?? {}).filter((c) => c !== 'public')).toEqual([]);
  });

  it('every GLB on disk is in the snapshot', () => {
    const known = new Set(Object.keys(SNAPSHOT.glbs));
    expect(listGlbLabels().filter((l) => !known.has(l)), 'regenerate tests/fixtures/reference-baseline.json').toEqual([]);
  });
});
