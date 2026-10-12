// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// bunny-deploy-stale.node.test.ts — the rule that decides what a deploy may
// DELETE from the CDN. Regression guard for 2026-09-07: a plain `npm run deploy`
// (zone root, no --path) listed the whole storage zone and deleted every file
// outside its dist — the CONNECT installer and manifests under download/, the
// dev/ demo and three live customer projects. A deploy owns only the top-level
// entries its own dist carries; everything else is foreign and stays.

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import { selectStaleEntries } from '../scripts/bunny-deploy.mjs';

const entry = (rel: string) => ({ rel, size: 1, isDirectory: false });

describe('selectStaleEntries — a deploy owns only its own top-level tree', () => {
  const dist = ['index.html', 'assets/index-abc.js', 'models/DemoRealvirtual.glb', 'settings.json'];

  it('deletes stale files inside the owned tree', () => {
    const { stale, foreign } = selectStaleEntries(
      [entry('index.html'), entry('assets/index-old.js'), entry('models/old.glb')], dist);
    expect(stale.map((e: { rel: string }) => e.rel)).toEqual(['assets/index-old.js', 'models/old.glb']);
    expect(foreign).toEqual([]);
  });

  it('never touches sibling folders at the zone root (the 2026-09-07 incident)', () => {
    const zone = [
      entry('index.html'),
      entry('download/realvirtual-Connect.exe'),
      entry('download/connect-latest.json'),
      entry('download/versions/realvirtual-Connect-1.2.2+40.exe'),
      entry('demo/index.html'),
      entry('dev/index.html'),
      entry('a9d6c728c2a7006e52e55c03a174efbf/index.html'),
      entry('assets/index-old.js'),
    ];
    const { stale, foreign } = selectStaleEntries(zone, dist);
    expect(stale.map((e: { rel: string }) => e.rel)).toEqual(['assets/index-old.js']);
    expect(foreign).toEqual([
      'download/realvirtual-Connect.exe',
      'download/connect-latest.json',
      'download/versions/realvirtual-Connect-1.2.2+40.exe',
      'demo/index.html',
      'dev/index.html',
      'a9d6c728c2a7006e52e55c03a174efbf/index.html',
    ]);
  });

  it('keeps a stale root file that dist no longer carries, since the root itself is not owned', () => {
    // `logo.png` at the zone root but absent from dist: its top segment is the file
    // itself, which is not among dist's top-level entries → foreign, not stale.
    const { stale, foreign } = selectStaleEntries([entry('logo.png')], dist);
    expect(stale).toEqual([]);
    expect(foreign).toEqual(['logo.png']);
  });

  it('still honours preserveRemotePrefixes inside the owned tree (private deploy)', () => {
    const { stale, foreign } = selectStaleEntries(
      [entry('assets/index-old.js'), entry('private-assets/proj/model.glb')],
      [...dist, 'private-assets/keep.json'],
      ['private-assets/'],
    );
    expect(stale.map((e: { rel: string }) => e.rel)).toEqual(['assets/index-old.js']);
    expect(foreign).toEqual([]);
  });

  it('compares case-insensitively and tolerates backslashes, as Bunny listings do', () => {
    const { stale } = selectStaleEntries(
      [entry('Assets\\Index-ABC.js'), entry('assets\\gone.js')], dist);
    expect(stale.map((e: { rel: string }) => e.rel)).toEqual(['assets/gone.js']);
  });
});
