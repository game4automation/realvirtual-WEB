// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The per-zone `*.connect.json` handover globs (plan-725 §2.8, F8).
 *
 * Since plan-725 CONNECT finds a configuration anywhere in the project, so a
 * customer's `*.connect.json` can now sit next to the model it belongs to —
 * inside a vendor-managed zone. Without these globs the next delivery would
 * classify it as ours and overwrite it.
 *
 * Two things are pinned here, and they are pinned against the REAL validator and
 * the REAL classifier rather than against a restatement of them:
 *
 *  - the default block still validates (`vendorGlobProblems` → `[]`), and
 *  - a connect config is the customer's at BOTH depths, while everything else in
 *    the same zone stays ours.
 *
 * The second point is the one that has bitten before: `models/**\/*.connect.json`
 * alone does not cover `models/linie1.connect.json`, because `**` there demands
 * at least one intermediate directory. That is why there are two entries per
 * zone and not one.
 */

import { describe, it, expect } from 'vitest';

import {
  CONNECT_CONFIG_HANDOVER_GLOBS,
  DEFAULT_MANAGED_ZONES,
  DEFAULT_VENDOR_BLOCK,
  vendorGlobProblems,
} from '../scripts/_rv-guards.mjs';
import { classifyPath } from '../scripts/_vendor-merge.mjs';

/** The default block as a plain, mutable object — the shape a manifest carries. */
const defaults = {
  managed: [...DEFAULT_VENDOR_BLOCK.managed],
  handover: [...DEFAULT_VENDOR_BLOCK.handover],
};

describe('vendor handover — connect configs', () => {
  it('vendorGlobProblems is empty for the per-zone handover globs', () => {
    expect(vendorGlobProblems(defaults)).toEqual([]);
  });

  it('classifies models/linie1.connect.json as customer', () => {
    expect(classifyPath('models/linie1.connect.json', defaults)).toBe('customer');
  });

  it('classifies models/sub/deep/b.connect.json as customer', () => {
    expect(classifyPath('models/sub/deep/b.connect.json', defaults)).toBe('customer');
  });

  it('still classifies models/linie1.glb as vendor', () => {
    expect(classifyPath('models/linie1.glb', defaults)).toBe('vendor');
  });

  it('covers every managed zone at both depths', () => {
    for (const zone of DEFAULT_MANAGED_ZONES) {
      expect(classifyPath(`${zone}/a.connect.json`, defaults), zone).toBe('customer');
      expect(classifyPath(`${zone}/sub/a.connect.json`, defaults), zone).toBe('customer');
    }
  });

  it('leaves the rest of a managed zone ours', () => {
    // The neighbours of a connect config, so "handover" cannot be read as
    // "the zone became the customer's".
    expect(classifyPath('connect/project-config.json', defaults)).toBe('vendor');
    expect(classifyPath('models/sub/deep/b.glb', defaults)).toBe('vendor');
    expect(classifyPath('docs/manual.md', defaults)).toBe('vendor');
    expect(classifyPath('rag/index.json', defaults)).toBe('vendor');
  });

  it('keeps the pre-existing handover entries', () => {
    // Regression guard: the connect globs were ADDED to the block, not
    // substituted for what protected the secret sidecar and models/custom/.
    expect(defaults.handover).toContain('connect/secrets.local.json');
    expect(defaults.handover).toContain('models/custom/**');
    expect(classifyPath('connect/secrets.local.json', defaults)).toBe('customer');
    expect(classifyPath('models/custom/mine.glb', defaults)).toBe('customer');
  });

  it('is exactly two entries per zone', () => {
    expect(CONNECT_CONFIG_HANDOVER_GLOBS).toHaveLength(DEFAULT_MANAGED_ZONES.length * 2);
    for (const zone of DEFAULT_MANAGED_ZONES) {
      expect(CONNECT_CONFIG_HANDOVER_GLOBS).toContain(`${zone}/*.connect.json`);
      expect(CONNECT_CONFIG_HANDOVER_GLOBS).toContain(`${zone}/**/*.connect.json`);
    }
  });

  /**
   * Why the one-entry forms were rejected — measured, so the reasoning in §2.8
   * cannot quietly stop being true.
   */
  it('rejects the blanket glob the shorter form would have used', () => {
    const problems = vendorGlobProblems({
      managed: [...DEFAULT_VENDOR_BLOCK.managed],
      handover: ['**/*.connect.json'],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/outside every "managed" glob/);
  });

  it('shows why the deep-only glob is not enough on its own', () => {
    const deepOnly = { managed: ['models/**'], handover: ['models/**/*.connect.json'] };
    expect(classifyPath('models/sub/a.connect.json', deepOnly)).toBe('customer');
    // The file directly in the zone — the common case — would stay ours.
    expect(classifyPath('models/linie1.connect.json', deepOnly)).toBe('vendor');
  });
});
