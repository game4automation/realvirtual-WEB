// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * projects-auto-open — the startup gate for the Projects dashboard
 * (plan-372 §2.12).
 *
 * The case that matters commercially is the last group: every delivered
 * customer build either sets `defaultModel` or runs kiosk-locked, and must keep
 * booting straight into its machine. A customer opening their HMI and landing
 * in a file browser would be a visible regression in every deployment at once.
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoOpenProjects } from '../src/core/hmi/projects/projects-auto-open';

const base = { search: '', defaultModel: null, modeLocked: false } as const;

describe('opens when the session asked for nothing', () => {
  it('opens on a bare start', () => {
    expect(shouldAutoOpenProjects({ ...base })).toBe(true);
  });

  it('ignores unrelated query parameters', () => {
    expect(shouldAutoOpenProjects({ ...base, search: '?mcpPort=5100&debug=1' })).toBe(true);
  });

  it('treats a blank routing parameter as absent', () => {
    expect(shouldAutoOpenProjects({ ...base, search: '?scene=' })).toBe(true);
    expect(shouldAutoOpenProjects({ ...base, defaultModel: '   ' })).toBe(true);
  });
});

describe('stays shut when the session already knows what to show', () => {
  it.each(['?project=demo', '?scene=abc', '?model=/models/x.glb'])('%s', (search) => {
    expect(shouldAutoOpenProjects({ ...base, search })).toBe(false);
  });

  it('stays shut with a configured defaultModel', () => {
    expect(shouldAutoOpenProjects({ ...base, defaultModel: 'line.glb' })).toBe(false);
  });

  it('stays shut in a kiosk (mode locked)', () => {
    expect(shouldAutoOpenProjects({ ...base, modeLocked: true })).toBe(false);
  });
});

describe('the two config flags', () => {
  it('suppress wins over an otherwise-open session', () => {
    expect(shouldAutoOpenProjects({ ...base, suppress: true })).toBe(false);
  });

  it('force opens even with a defaultModel', () => {
    expect(shouldAutoOpenProjects({ ...base, defaultModel: 'line.glb', force: true })).toBe(true);
  });

  it('force opens even with routing parameters', () => {
    expect(shouldAutoOpenProjects({ ...base, search: '?scene=abc', force: true })).toBe(true);
  });

  it('suppress beats force — a contradictory config resolves to no window', () => {
    expect(shouldAutoOpenProjects({ ...base, suppress: true, force: true })).toBe(false);
  });

  it('a locked mode beats force — a kiosk is never talked into a browser', () => {
    expect(shouldAutoOpenProjects({ ...base, modeLocked: true, force: true })).toBe(false);
  });
});

describe('delivered customer builds are unaffected', () => {
  it('a defaultModel deploy boots into its model', () => {
    expect(shouldAutoOpenProjects({
      search: '', defaultModel: 'customer-line.glb', modeLocked: false,
    })).toBe(false);
  });

  it('a kiosk deploy boots into its model', () => {
    expect(shouldAutoOpenProjects({
      search: '', defaultModel: null, modeLocked: true,
    })).toBe(false);
  });
});
