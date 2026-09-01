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

describe('a failed boot-restore opens the list (plan-702 Punkt 3)', () => {
  it('opens even when routing parameters are present — they refer to the missing project', () => {
    expect(shouldAutoOpenProjects({ ...base, search: '?scene=abc', restoreFailed: true })).toBe(true);
  });

  it('opens even with a configured defaultModel', () => {
    expect(shouldAutoOpenProjects({ ...base, defaultModel: 'line.glb', restoreFailed: true })).toBe(true);
  });

  it('a kiosk still never opens the browser', () => {
    expect(shouldAutoOpenProjects({ ...base, modeLocked: true, restoreFailed: true })).toBe(false);
  });

  it('suppress still wins', () => {
    expect(shouldAutoOpenProjects({ ...base, suppress: true, restoreFailed: true })).toBe(false);
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

// ─── The appliance shape (plan-721, review finding 13) ───────────────────

/**
 * `shouldAutoOpenProjects` needs no change for plan-721 — these are the
 * confirmation tests that say so, and they earn their place because the
 * appliance is the first deployment that has NO global `defaultModel` at all.
 * Before this plan, "no defaultModel" was the strongest signal that the session
 * had nothing to show, i.e. the dashboard's main reason to open; the box now
 * relies entirely on the kiosk lock to keep it shut.
 *
 * Decision 1 of the grill is what is at stake: the Projects dashboard is not an
 * operator surface on the box, not even as a hybrid. An appliance that opened a
 * file browser instead of its machine would be visible to every operator at
 * once.
 */
describe('the appliance serves ONE project and never the dashboard (plan-721)', () => {
  it('no global defaultModel + kiosk lock still keeps the dashboard shut', () => {
    // The exact delivered shape: `settings.json` carries `mode.lock` and no
    // `defaultModel`; the start document comes from `project.json` instead.
    expect(shouldAutoOpenProjects({
      search: '', defaultModel: null, modeLocked: true,
    })).toBe(false);
  });

  it('the served-project URL does not talk it open either', () => {
    expect(shouldAutoOpenProjects({
      search: '?projectUrl=/p/mauser/', defaultModel: null, modeLocked: true,
    })).toBe(false);
  });

  it('and force cannot override the lock, however the config is generated', () => {
    expect(shouldAutoOpenProjects({
      search: '', defaultModel: null, modeLocked: true, force: true,
    })).toBe(false);
  });

  it('dropping the lock for commissioning is what re-opens it', () => {
    // The F5 escape hatch, stated positively: unlocking is a deliberate act,
    // and only then does the box behave like an authoring install.
    expect(shouldAutoOpenProjects({
      search: '', defaultModel: null, modeLocked: false,
    })).toBe(true);
  });
});

// ─── The project's own start document (plan-726 F3, §9.3) ───────────────

/**
 * The second suppressor, and why it had to exist.
 *
 * Before plan-726 the public demo carried `defaultModel` in `settings.json`,
 * and that field alone kept the dashboard shut. The demo now boots from its
 * `project.json` instead and ships NO global `defaultModel` at all — so on the
 * one deployment that must never greet a first-time visitor with a file
 * browser, the old signal is empty.
 *
 * `projectStartDocument` carries the same meaning ("the session already knows
 * what to show") and is therefore checked in the same place, with the same
 * precedence relative to `suppress`, `force`, `modeLocked` and `restoreFailed`.
 */
describe('the active project can say what to show (plan-726 F3)', () => {
  it('a project start document keeps the dashboard shut without any defaultModel', () => {
    // The delivered public-demo shape exactly: no global default, not locked.
    expect(shouldAutoOpenProjects({
      ...base, projectStartDocument: 'models/DemoRealvirtualWeb.glb',
    })).toBe(false);
  });

  it('neither signal present still opens — the old behaviour is untouched', () => {
    expect(shouldAutoOpenProjects({ ...base, projectStartDocument: null })).toBe(true);
    expect(shouldAutoOpenProjects({ ...base, projectStartDocument: undefined })).toBe(true);
  });

  it('treats a blank start document as absent, like defaultModel', () => {
    expect(shouldAutoOpenProjects({ ...base, projectStartDocument: '   ' })).toBe(true);
  });

  it('force still opens over it — the flag outranks both suppressors', () => {
    expect(shouldAutoOpenProjects({
      ...base, projectStartDocument: 'models/Line.glb', force: true,
    })).toBe(true);
  });

  it('suppress still wins over force', () => {
    expect(shouldAutoOpenProjects({
      ...base, projectStartDocument: 'models/Line.glb', suppress: true, force: true,
    })).toBe(false);
  });

  it('a kiosk is still never talked into the browser', () => {
    expect(shouldAutoOpenProjects({
      ...base, projectStartDocument: 'models/Line.glb', modeLocked: true, force: true,
    })).toBe(false);
  });

  it('a failed boot-restore still opens the list over it', () => {
    // Same rule the `defaultModel` case has: whatever the session said, it
    // referred to a project that is not there.
    expect(shouldAutoOpenProjects({
      ...base, projectStartDocument: 'models/Line.glb', restoreFailed: true,
    })).toBe(true);
  });

  it('AutoOpenInputs stays additive — an old caller compiles and behaves the same', () => {
    // The field is optional; a caller that never learnt about it gets exactly
    // the pre-726 verdict.
    expect(shouldAutoOpenProjects({ search: '', defaultModel: null, modeLocked: false })).toBe(true);
    expect(shouldAutoOpenProjects({ search: '', defaultModel: 'x.glb', modeLocked: false })).toBe(false);
  });
});
