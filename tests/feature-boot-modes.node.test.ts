// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 Phase 2 — boot target resolution (§9.4, unit part).
 *
 * `resolveBootMode` must keep the boot block's precedence exactly:
 * lock > `?mode=` > hosted start (plan-640) > published > resume > restore('hmi'),
 * each candidate only when the mode is registered.
 */

import { describe, it, expect } from 'vitest';
import { resolveBootMode, type BootModeCandidates } from '../src/core/rv-boot-mode';

const host = (registered: string[], persisted: string | null = null) => ({
  has: (id: string) => registered.includes(id),
  peekRestoreTarget: (fallback = 'hmi') => (persisted && registered.includes(persisted) ? persisted : fallback),
});
const none: BootModeCandidates = { locked: null, url: null, hostedStart: null, published: null, resume: null };
const all = ['hmi', 'planner', 'editor', 'des'];

describe('resolveBootMode (plan-652)', () => {
  it('walks the established precedence', () => {
    const c = { locked: null, url: 'editor', hostedStart: 'planner', published: 'des', resume: 'hmi' };
    expect(resolveBootMode(c, host(all))).toEqual({ mode: 'editor', source: 'url' });
    expect(resolveBootMode({ ...c, url: null }, host(all))).toEqual({ mode: 'planner', source: 'hostedStart' });
    expect(resolveBootMode({ ...c, url: null, hostedStart: null }, host(all))).toEqual({ mode: 'des', source: 'published' });
    expect(resolveBootMode({ ...none, resume: 'planner' }, host(all))).toEqual({ mode: 'planner', source: 'resume' });
  });

  it('falls through unknown candidates to the next valid one', () => {
    const c = { ...none, url: 'bogus', hostedStart: 'alsoBogus', published: 'planner' };
    expect(resolveBootMode(c, host(all))).toEqual({ mode: 'planner', source: 'published' });
    expect(resolveBootMode({ ...none, url: 'editor' }, host(['hmi', 'planner']))).toEqual({ mode: 'hmi', source: 'restore' });
  });

  it('ends at the persisted mode, else hmi', () => {
    expect(resolveBootMode(none, host(all, 'des'))).toEqual({ mode: 'des', source: 'restore' });
    expect(resolveBootMode(none, host(all))).toEqual({ mode: 'hmi', source: 'restore' });
  });

  it('a kiosk lock wins over every candidate', () => {
    expect(resolveBootMode({ ...none, locked: 'editor', url: 'planner' }, host(all))).toEqual({ mode: 'editor', source: 'locked' });
  });
});
