// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression tests for the "empty grey strip on the left" bug.
 *
 * The leftPanelManager slot (`activePanel`) persists in localStorage and is
 * restored on boot, but the gates that actually mount each panel don't persist
 * the same way — `settingsOpen` is never persisted, and the SceneStore singleton
 * may not exist yet when the slot is restored. `orphanedLeftSlot` detects that
 * desync so TopBar can drop the orphaned slot (otherwise the inset reserves an
 * empty strip). Plugin-backed panels (machine-control) drop their own slot.
 */

import { describe, it, expect } from 'vitest';
import { orphanedLeftSlot } from '../src/core/hmi/TopBar';

const READY = { settingsOpen: true, hierarchyOpen: true };
/** No workspace gate is shut — the pre-plan-387 world. */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

describe('orphanedLeftSlot', () => {
  it('flags settings as orphaned when the lpm slot is open but settingsOpen is false (post-reload)', () => {
    expect(orphanedLeftSlot('settings', { ...READY, settingsOpen: false }, NOTHING_HIDDEN)).toBe('settings');
  });

  it('flags hierarchy as orphaned when the lpm slot is open but hierarchyOpen is false', () => {
    expect(orphanedLeftSlot('hierarchy', { ...READY, hierarchyOpen: false }, NOTHING_HIDDEN)).toBe('hierarchy');
  });

  it('always flags a persisted scene slot as orphaned — the window no longer exists', () => {
    // plan-372 Phase 13 deleted the Scene window. A 'scene' slot restored from
    // an older session can never render, so it must always be reclaimed —
    // regardless of the rest of the renderer state.
    expect(orphanedLeftSlot('scene', READY, NOTHING_HIDDEN)).toBe('scene');
    expect(orphanedLeftSlot('scene', { settingsOpen: false, hierarchyOpen: false }, NOTHING_HIDDEN)).toBe('scene');
  });

  it('returns null when settings slot and renderer agree (normal open)', () => {
    expect(orphanedLeftSlot('settings', READY, NOTHING_HIDDEN)).toBeNull();
  });

  it('returns null when hierarchy slot and renderer agree (normal open)', () => {
    expect(orphanedLeftSlot('hierarchy', READY, NOTHING_HIDDEN)).toBeNull();
  });

  it('leaves slots with a live renderer alone', () => {
    // The counterpart to the scene case: settings and hierarchy still have
    // renderers, so a matching open slot is not orphaned.
    expect(orphanedLeftSlot('hierarchy', READY, NOTHING_HIDDEN)).toBeNull();
  });

  it('returns null for unrelated panels (e.g. annotations/machine-control) — gated elsewhere', () => {
    expect(orphanedLeftSlot('annotations', { settingsOpen: false, hierarchyOpen: false }, NOTHING_HIDDEN)).toBeNull();
    expect(orphanedLeftSlot('machine-control', { settingsOpen: false, hierarchyOpen: false }, NOTHING_HIDDEN)).toBeNull();
  });

  it('returns null when no panel slot is active', () => {
    expect(orphanedLeftSlot(null, { settingsOpen: false, hierarchyOpen: false }, NOTHING_HIDDEN)).toBeNull();
  });

  // ── The workspace-visibility half (plan-387 follow-up) ──────────────────
  // Which slots land in the set is decided by left-panel-visibility.ts and
  // exercised per panel in rv-viewer-mode.test.ts; here only the branch itself.

  it('flags any slot the caller reports as hidden, whatever the renderer says', () => {
    expect(orphanedLeftSlot('connect', READY, new Set(['connect']))).toBe('connect');
    expect(orphanedLeftSlot('order-manager', READY, new Set(['order-manager']))).toBe('order-manager');
  });

  it('a shut gate beats a healthy per-panel flag', () => {
    // hierarchyOpen is true — without the visibility branch this would be null,
    // which is exactly the bug: the slot kept reserving width in the viewer.
    expect(orphanedLeftSlot('hierarchy', READY, new Set(['hierarchy']))).toBe('hierarchy');
  });

  it('leaves the OTHER slots alone while one is hidden', () => {
    expect(orphanedLeftSlot('settings', READY, new Set(['hierarchy', 'annotations']))).toBeNull();
  });

  it('ignores an empty active slot even when the set is non-empty', () => {
    expect(orphanedLeftSlot(null, READY, new Set(['hierarchy']))).toBeNull();
  });
});
