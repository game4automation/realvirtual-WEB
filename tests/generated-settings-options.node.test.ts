// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `generatedSettings()` and its two plan-721 options (F7).
 *
 * The point of these tests is NOT the two new keys — it is the promise that
 * came with them: **an option, not a fourth copy.** `customer-workspace.node.test.ts`
 * asserts the delivered shape end to end and must stay green unchanged, so the
 * job here is to pin the no-options path byte for byte and then show that each
 * option changes exactly one thing.
 *
 * Why `omitDefaultModel` exists at all: since plan-716 the project manifest is
 * the single source of truth for what a project contains, and an appliance
 * boots from it. A `defaultModel` baked into the runtime alongside it is a
 * second answer to "which document opens first" — the LOP-116 class of bug,
 * where the two drift and the stale one wins because the code reads it first.
 */

import { describe, it, expect } from 'vitest';
import { generatedSettings } from '../scripts/_workspace-lib.mjs';

const PROJECT = { settings: { defaultModel: 'models/Machine.glb' } };
const DELIVERY = { connectChannel: 'stable', connectLicenseKey: 'RVC1-TEST' };

describe('the delivered shape is unchanged when no option is passed', () => {
  it('produces exactly what it produced before the options existed', () => {
    // Frozen on purpose: the three existing callers of the workspace build
    // depend on this object, and the option must be invisible to them.
    expect(generatedSettings(PROJECT, DELIVERY, null)).toEqual({
      defaultModel: 'Machine.glb',
      connectChannel: 'stable',
      connectLicensePrefill: 'RVC1-TEST',
      analytics: { googleAnalyticsId: '' },
    });
  });

  it('an omitted options argument behaves like an empty one', () => {
    expect(generatedSettings(PROJECT, DELIVERY, null))
      .toEqual(generatedSettings(PROJECT, DELIVERY, null, {}));
  });

  it('key ORDER is preserved — defaultModel still comes first', () => {
    // The delivered file is committed to a customer repository, so a reordering
    // would show up as a diff in every delivery at once.
    expect(Object.keys(generatedSettings(PROJECT, DELIVERY, null)))
      .toEqual(['defaultModel', 'connectChannel', 'connectLicensePrefill', 'analytics']);
  });

  it('still leaves the licence key out of a shared repository', () => {
    // Pre-existing plan-434 §2.7 rule, re-asserted because the function was
    // touched: in a repo every standard customer can read, one customer's key
    // would be visible to all of them.
    const shared = generatedSettings(PROJECT, { ...DELIVERY, sharedRepo: true }, null);
    expect('connectLicensePrefill' in shared).toBe(false);
  });

  it('still carries the CONNECT pin when one is given', () => {
    const pinned = generatedSettings(PROJECT, DELIVERY, { version: '1.2.3' });
    expect(pinned.connectDownload).toEqual({ channel: 'stable', version: '1.2.3' });
  });
});

describe('omitDefaultModel leaves the key OUT, not blank', () => {
  it('drops it entirely', () => {
    const settings = generatedSettings(PROJECT, DELIVERY, null, { omitDefaultModel: true });
    // Absent, not `''`. An empty string still reads as a configured value to
    // `resolveResumeTarget`'s caller and would keep the second source of truth
    // alive in a form that merely looks harmless.
    expect('defaultModel' in settings).toBe(false);
  });

  it('changes nothing else', () => {
    const withKey = generatedSettings(PROJECT, DELIVERY, null);
    const without = generatedSettings(PROJECT, DELIVERY, null, { omitDefaultModel: true });
    const { defaultModel: _dropped, ...rest } = withKey;
    expect(without).toEqual(rest);
  });

  it('is opt-IN — false and undefined both keep the key', () => {
    expect(generatedSettings(PROJECT, DELIVERY, null, { omitDefaultModel: false }).defaultModel)
      .toBe('Machine.glb');
    expect(generatedSettings(PROJECT, DELIVERY, null, { omitDefaultModel: undefined }).defaultModel)
      .toBe('Machine.glb');
    // Only an exact `true` counts: a truthy string from a config file must not
    // silently change what a delivery contains. The cast is the point of the
    // test — TypeScript rejects this shape, and a delivery config read from
    // JSON at runtime does not go through TypeScript.
    expect(generatedSettings(PROJECT, DELIVERY, null,
      { omitDefaultModel: 'yes' } as unknown as { omitDefaultModel?: boolean }).defaultModel)
      .toBe('Machine.glb');
  });
});

describe('modeLock is the kiosk half of the same delivery (F5)', () => {
  it('writes the flag the viewer reads', () => {
    expect(generatedSettings(PROJECT, DELIVERY, null, { modeLock: 'hmi' }).mode)
      .toEqual({ lock: 'hmi' });
  });

  it('is absent by default and for a blank value', () => {
    expect('mode' in generatedSettings(PROJECT, DELIVERY, null)).toBe(false);
    expect('mode' in generatedSettings(PROJECT, DELIVERY, null, { modeLock: '' })).toBe(false);
    expect('mode' in generatedSettings(PROJECT, DELIVERY, null, { modeLock: '   ' })).toBe(false);
  });

  it('combines with omitDefaultModel — that IS the appliance shape', () => {
    const appliance = generatedSettings(PROJECT, DELIVERY, null, {
      omitDefaultModel: true, modeLock: 'hmi',
    });
    expect('defaultModel' in appliance).toBe(false);
    expect(appliance.mode).toEqual({ lock: 'hmi' });
  });
});
