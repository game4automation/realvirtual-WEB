// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-assets-base — which directory a project's docs / AASX come from
 * (plan-372 Phase 14).
 *
 * The failure this prevents is invisible in the UI: with a deployment-wide
 * base, switching project keeps serving the PREVIOUS project's datasheets. A
 * PDF still opens — it is simply the wrong PDF.
 */

import { describe, it, expect } from 'vitest';
import {
  projectAssetsBase,
  resolveAssetsBase,
} from '../src/core/project/rv-project-assets-base';
import type { RvProject } from '../src/core/project/rv-project-types';

const project = (over: Partial<RvProject>): RvProject =>
  ({ id: 'p1', name: 'P', schemaVersion: 1, ...over }) as RvProject;

describe('projectAssetsBase', () => {
  it('returns null when the project declares nothing', () => {
    expect(projectAssetsBase(null, 'docs', '/base/')).toBeNull();
    expect(projectAssetsBase(project({}), 'docs', '/base/')).toBeNull();
    expect(projectAssetsBase(project({ docs: {} }), 'docs', '/base/')).toBeNull();
    expect(projectAssetsBase(project({ docs: { basePath: '  ' } }), 'docs', '/base/')).toBeNull();
  });

  it('resolves a relative basePath against the fallback so manifests stay portable', () => {
    expect(projectAssetsBase(project({ docs: { basePath: 'docs' } }), 'docs', '/deploy/'))
      .toBe('/deploy/docs/');
  });

  it('keeps an absolute basePath as given', () => {
    expect(projectAssetsBase(project({ docs: { basePath: 'https://cdn/x' } }), 'docs', '/deploy/'))
      .toBe('https://cdn/x/');
    expect(projectAssetsBase(project({ docs: { basePath: '/abs' } }), 'docs', '/deploy/'))
      .toBe('/abs/');
  });

  it('keeps docs and aasx separate', () => {
    const p = project({ docs: { basePath: 'docs' }, aasx: { basePath: 'aasx' } });
    expect(projectAssetsBase(p, 'docs', '/d/')).toBe('/d/docs/');
    expect(projectAssetsBase(p, 'aasx', '/d/')).toBe('/d/aasx/');
  });

  it('does not read indexRef — it is a directory question, not an index parse', () => {
    const p = project({ docs: { indexRef: 'docs/index.json' } });
    expect(projectAssetsBase(p, 'docs', '/d/')).toBeNull();
  });
});

describe('resolveAssetsBase precedence', () => {
  const p = project({ aasx: { basePath: 'aasx' } });

  it('an explicit per-model path wins over the project', () => {
    expect(resolveAssetsBase({ explicit: '/model/assets', project: p, kind: 'aasx', fallbackBase: '/d/' }))
      .toBe('/model/assets/');
  });

  it('the project wins over the deployment fallback', () => {
    expect(resolveAssetsBase({ explicit: null, project: p, kind: 'aasx', fallbackBase: '/d/' }))
      .toBe('/d/aasx/');
  });

  it('falls back to the deployment base when nothing else applies', () => {
    // A bundled deploy has no manifest at all and must keep working unchanged.
    expect(resolveAssetsBase({ project: null, kind: 'aasx', fallbackBase: '/d/' })).toBe('/d/');
  });

  it('an empty explicit string does not beat the project', () => {
    expect(resolveAssetsBase({ explicit: '   ', project: p, kind: 'aasx', fallbackBase: '/d/' }))
      .toBe('/d/aasx/');
  });

  it('always ends in exactly one slash so callers can concatenate', () => {
    for (const base of ['/d', '/d/']) {
      expect(resolveAssetsBase({ project: null, kind: 'docs', fallbackBase: base })).toBe('/d/');
    }
  });
});
