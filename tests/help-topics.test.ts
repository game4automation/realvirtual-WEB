// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-370 §9.1 — the topic tables, checked data-driven against the offline
 * sitemap snapshot (F7). Walks EVERY real panel id and EVERY workspace mode
 * rather than restating a handful of examples, and pins down that an unknown
 * id falls through instead of throwing.
 */

import { describe, it, expect } from 'vitest';
import {
  KNOWN_DOC_SLUGS, PANEL_TOPICS, MODE_TOPICS, HELP_FALLBACK, DOC_SLUG_LABELS,
  helpTopicLabel,
} from '../src/core/hmi/help-topics';
import { deriveHelpTopic } from '../src/core/hmi/help-context';

/**
 * The 11 panel ids that really reach `leftPanelManager.open()/toggle()`.
 * `'other'` is NOT one of them — it only ever appears in a comment.
 */
const REAL_PANEL_IDS = [
  'annotations', 'connect', 'hierarchy', 'kinematics', 'layout-planner',
  'machine-control', 'materials', 'measurements', 'order-manager',
  'scene', 'settings',
] as const;

const REAL_MODES = ['hmi', 'des', 'planner', 'editor'] as const;

describe('help topic tables', () => {
  it.each(REAL_PANEL_IDS)('panel %s resolves to a documented slug', (id) => {
    const topic = PANEL_TOPICS[id] ?? null;
    expect(topic).not.toBeNull();
    expect(KNOWN_DOC_SLUGS).toContain(topic!.slug);
  });

  it.each(REAL_MODES)('mode %s resolves to a documented slug', (mode) => {
    expect(MODE_TOPICS[mode]).toBeDefined();
    expect(KNOWN_DOC_SLUGS).toContain(MODE_TOPICS[mode].slug);
  });

  it('covers every known panel id explicitly (no silent gaps)', () => {
    for (const id of REAL_PANEL_IDS) {
      expect(
        Object.prototype.hasOwnProperty.call(PANEL_TOPICS, id),
        `panel '${id}' is neither mapped nor explicitly excluded`,
      ).toBe(true);
    }
  });

  it('does not claim the reserved placeholder as a real panel', () => {
    expect(Object.prototype.hasOwnProperty.call(PANEL_TOPICS, 'other')).toBe(false);
  });

  // Panel ids can also appear dynamically at runtime — an unknown one must not
  // throw, it must fall through to the mode and then to the root.
  it('lets an unknown panel id fall through instead of throwing', () => {
    expect(deriveHelpTopic({ panel: 'not-a-real-panel', mode: null, pluginTopic: null }))
      .toEqual(HELP_FALLBACK);
    expect(deriveHelpTopic({ panel: 'not-a-real-panel', mode: 'des', pluginTopic: null }).slug)
      .toBe('des/overview');
  });

  it('stores slugs without leading or trailing slashes', () => {
    for (const t of [...Object.values(PANEL_TOPICS), ...Object.values(MODE_TOPICS)]) {
      expect(t.slug).not.toMatch(/^\/|\/$/);
    }
  });

  it('uses the documentation root as fallback', () => {
    expect(HELP_FALLBACK.slug).toBe('');
    expect(KNOWN_DOC_SLUGS).toContain('');
  });

  it('labels every documented slug for the accessible name', () => {
    for (const slug of KNOWN_DOC_SLUGS) {
      expect(DOC_SLUG_LABELS[slug], `slug '${slug}' has no label`).toBeTruthy();
    }
    expect(helpTopicLabel({ slug: 'planner/overview' })).toBe('Layout Planner');
    expect(helpTopicLabel(HELP_FALLBACK)).toBe('realvirtual WEB');
    // A plugin may point at documentation we know nothing about.
    expect(helpTopicLabel({ slug: 'vendor/thing' })).toBe('vendor/thing');
  });
});
