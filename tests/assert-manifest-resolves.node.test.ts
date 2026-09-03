// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * assertManifestResolves — the gate's own specification (plan-731 4b).
 *
 * The helper is used by every channel harness, so it needs a specification and
 * not just usages: a gate that quietly stopped refusing would make all of its
 * callers pass, and each of them would then be asserting nothing while looking
 * like it asserted something. The interesting behaviour of a gate is the
 * REFUSAL, so every rule gets a negative case here.
 *
 * Node rather than browser: every question it asks is about files on disk.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertManifestResolves } from './helpers/assert-manifest-resolves';

let work = '';
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = '';
});

/** A staged root: files written, manifest written, nothing implied. */
function stage(opts: {
  documents?: unknown[];
  files?: string[];
  settings?: unknown;
  manifest?: unknown;
  noManifest?: boolean;
  rawManifest?: string;
} = {}): string {
  work = mkdtempSync(join(tmpdir(), 'rv-gate-'));
  const root = join(work, 'dist');
  mkdirSync(root, { recursive: true });
  for (const rel of opts.files ?? []) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, rel);
  }
  if (opts.noManifest) return root;
  if (typeof opts.rawManifest === 'string') {
    writeFileSync(join(root, 'project.json'), opts.rawManifest);
    return root;
  }
  writeFileSync(join(root, 'project.json'), JSON.stringify(opts.manifest ?? {
    schemaVersion: 2,
    id: 'prj_sample',
    name: 'DemoRealvirtual',
    canonicalName: 'demorealvirtual',
    settings: opts.settings ?? { defaultModel: 'Demo.glb' },
    documents: opts.documents ?? [
      { id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models' },
    ],
  }, null, 2));
  return root;
}

/** The healthy shape every negative case below deforms by exactly one thing. */
function healthy() {
  return stage({ files: ['Demo.glb', 'Planner.glb'], documents: [
    { id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models' },
    { id: 'doc_b', name: 'Planner', path: 'Planner.glb', section: 'scenes' },
  ] });
}

describe('assertManifestResolves — the passing case', () => {
  it('returns the rows it checked, and the start document among them', () => {
    const out = assertManifestResolves(healthy());
    expect(out.documents.map(d => d.path)).toEqual(['Demo.glb', 'Planner.glb']);
    expect(out.start.path).toBe('Demo.glb');
    expect(out.sidecars).toEqual([]);
  });

  it('accepts documents in a subfolder', () => {
    const root = stage({
      files: ['models/Demo.glb'],
      settings: { defaultModel: 'models/Demo.glb' },
      documents: [{ id: 'doc_a', name: 'Demo', path: 'models/Demo.glb', section: 'models' }],
    });
    expect(assertManifestResolves(root).documents).toHaveLength(1);
  });

  it('accepts and reports a declared sidecar that travelled', () => {
    const root = stage({
      files: ['Demo.glb', 'Demo.settings.json'],
      documents: [{
        id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models',
        settingsPath: 'Demo.settings.json',
      }],
    });
    expect(assertManifestResolves(root).sidecars).toEqual(['Demo.settings.json']);
  });
});

describe('assertManifestResolves — every rule refuses', () => {
  it('refuses a root with no manifest at all', () => {
    const root = stage({ files: ['Demo.glb'], noManifest: true });
    expect(() => assertManifestResolves(root)).toThrow(/no project\.json/);
  });

  it('refuses a manifest that is not JSON', () => {
    const root = stage({ files: ['Demo.glb'], rawManifest: '{ not json' });
    expect(() => assertManifestResolves(root)).toThrow(/not valid JSON/);
  });

  it('refuses a manifest that fails the v2 schema', () => {
    // No `documents` array at all — the shape `BundledBackend.readManifest()`
    // would fall back on (plan-726 F11b).
    const root = stage({
      files: ['Demo.glb'],
      manifest: { schemaVersion: 2, id: 'prj_sample', name: 'D' },
    });
    expect(() => assertManifestResolves(root)).toThrow(/not a valid v2 manifest/);
  });

  it('refuses an empty document list', () => {
    const root = stage({ files: ['Demo.glb'], documents: [] });
    expect(() => assertManifestResolves(root)).toThrow(/no documents/);
  });

  it('refuses a document whose file did not travel, and names it', () => {
    const root = stage({
      files: ['Demo.glb'],
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models' },
        { id: 'doc_b', name: 'Ghost', path: 'Ghost.glb', section: 'scenes' },
      ],
    });
    expect(() => assertManifestResolves(root)).toThrow(/Ghost\.glb/);
    expect(() => assertManifestResolves(root)).toThrow(/not here/);
  });

  it('refuses a devOnly row that survived the prune', () => {
    // The rule plan-731 2k exists to make checkable at all.
    const root = stage({
      files: ['Demo.glb', 'Fixture.glb'],
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models' },
        { id: 'doc_f', name: 'Fixture', path: 'Fixture.glb', section: 'scenes', devOnly: true },
      ],
    });
    expect(() => assertManifestResolves(root)).toThrow(/dev-only document "Fixture\.glb"/);
  });

  it('refuses a devOnly row even when its file is present and healthy', () => {
    // Present bytes are not the question — a fixture that ships is a fixture
    // that ships, and the file being there is what makes it invisible.
    const root = stage({
      files: ['Demo.glb', 'Fixture.glb'],
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models' },
        { id: 'doc_f', name: 'Fixture', path: 'Fixture.glb', section: 'models', devOnly: true },
      ],
    });
    expect(() => assertManifestResolves(root)).toThrow(/dev-only/);
  });

  it('refuses a manifest whose start document matches nothing', () => {
    const root = stage({
      files: ['Demo.glb'],
      settings: { defaultModel: 'NotThere.glb' },
      documents: [{ id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'library' }],
    });
    expect(() => assertManifestResolves(root)).toThrow(/start document/);
  });

  it('refuses a declared sidecar that did not travel', () => {
    const root = stage({
      files: ['Demo.glb'],
      documents: [{
        id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models',
        settingsPath: 'Demo.settings.json',
      }],
    });
    expect(() => assertManifestResolves(root)).toThrow(/did not travel/);
  });

  it('refuses a document path that escapes the delivery root', () => {
    const root = stage({
      files: ['Demo.glb'],
      settings: { defaultModel: 'Demo.glb' },
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'Demo.glb', section: 'models' },
        { id: 'doc_x', name: 'Escape', path: '../outside.glb', section: 'models' },
      ],
    });
    expect(() => assertManifestResolves(root)).toThrow(/escapes the delivery root/);
  });

  it('names the root in every message, so a failure says WHICH channel', () => {
    const root = stage({ files: [], noManifest: true });
    expect(() => assertManifestResolves(root)).toThrow(new RegExp(
      root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
  });
});

describe('assertManifestResolves — against the real demo source', () => {
  it('the source tree passes every rule except the devOnly one', () => {
    // Our own `public/` is the STAGED shape's ancestor and deliberately still
    // carries the fixture, so the gate must refuse it. That is the proof the
    // devOnly rule is live and not vacuously true — if it ever passed here,
    // every channel's use of it would be asserting nothing.
    const publicDir = resolve(__dirname, '..', 'public', 'demo-realvirtual');
    expect(() => assertManifestResolves(publicDir)).toThrow(/dev-only/);
  });
});
