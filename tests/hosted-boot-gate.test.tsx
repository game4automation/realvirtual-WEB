// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * hosted-boot-gate.test.tsx — plan-759 §9.3. The boot gate of a hosted deploy
 * in headless Chromium: resolves at once for an unencrypted deploy, mounts the
 * overlay for an encrypted one, keeps it open on a wrong password or a wrong
 * fragment, and after the right password holds the key for the publish salt
 * so a second call resolves without asking. Nothing is fetched by the gate:
 * the probe in settings.json is enough.
 *
 * The missing-`#k=` case lives in its own file: the fragment singleton is
 * parsed once per page, so a file can only test one of the two states.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import {
  encryptGlb, bytesToBase64Url, randomBytes, FRAGMENT_BYTES, PROBE_PLAINTEXT, PROBE_INFO,
} from '../src/core/persistence/rv-crypto-utils';
import { initFragmentSecret, getFragmentSecret, requireHostedPassword } from '../src/core/hmi/password-gate';
import { getSessionKey, clearSessionKeys } from '../src/core/persistence/rv-served-bytes';

const FRAG = randomBytes(FRAGMENT_BYTES);
const SALT = randomBytes(16);

async function probeFor(password: string, fragment: Uint8Array, salt: Uint8Array): Promise<string> {
  const env = new Uint8Array(await encryptGlb(new TextEncoder().encode(PROBE_PLAINTEXT), password, fragment, {
    salt, iterations: 1000, hkdfInfo: PROBE_INFO,
  }));
  let bin = '';
  for (const b of env) bin += String.fromCharCode(b);
  return btoa(bin);
}

const root = () => document.querySelector('#rv-password-gate-root');
const input = () => waitFor(() => {
  const el = document.querySelector('#rv-password-gate-root input') as HTMLInputElement | null;
  if (!el) throw new Error('gate input not mounted yet');
  return el;
});
const unlock = () =>
  Array.from(document.querySelectorAll('#rv-password-gate-root button')).find((b) =>
    /unlock/i.test(b.textContent ?? ''),
  ) as HTMLButtonElement;

/** Settled = resolved within a tick; a mounted gate keeps the promise pending. */
async function settled(p: Promise<void>): Promise<boolean> {
  return Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 50))]);
}

beforeAll(() => {
  window.location.hash = '#k=' + bytesToBase64Url(FRAG);
  initFragmentSecret();
});

describe('requireHostedPassword', () => {
  it('resolves at once and mounts nothing for an unencrypted deploy', async () => {
    clearSessionKeys();
    expect(await settled(requireHostedPassword({}))).toBe(true);
    expect(await settled(requireHostedPassword({ encryption: { enabled: false } }))).toBe(true);
    expect(await settled(requireHostedPassword({ encryption: { enabled: true } }))).toBe(true); // no probe = nothing to verify against
    expect(root()).toBeNull();
  });

  it('scrubbed the #k= fragment at boot (F6)', () => {
    expect(getFragmentSecret()).not.toBeNull();
    expect(window.location.hash).not.toContain('k=');
  });

  it('stays closed on a wrong password, opens on the right one, and remembers the key per salt', async () => {
    clearSessionKeys();
    const probe = await probeFor('richtig-2027', FRAG, SALT);
    const pending = requireHostedPassword({ encryption: { enabled: true, probe } });
    const field = await input();
    expect(root()?.textContent).toMatch(/password protected/i);
    expect(getSessionKey(SALT)).toBeNull();

    fireEvent.change(field, { target: { value: 'falsch' } });
    fireEvent.click(unlock());
    await waitFor(() => {
      if (!/Wrong password/i.test(root()?.textContent ?? '')) throw new Error('no error yet');
    });
    expect(await settled(pending)).toBe(false);
    expect(getSessionKey(SALT)).toBeNull();

    fireEvent.change(field, { target: { value: 'richtig-2027' } });
    fireEvent.click(unlock());
    await pending;
    expect(getSessionKey(SALT)).not.toBeNull();
    await waitFor(() => { if (root()) throw new Error('gate still mounted'); });

    // Same publish (same salt): no second question.
    expect(await settled(requireHostedPassword({ encryption: { enabled: true, probe } }))).toBe(true);
    expect(root()).toBeNull();
  });

  it('a second served project with another salt asks again (F13)', async () => {
    clearSessionKeys();
    const salt2 = randomBytes(16);
    const probe = await probeFor('pw-2', FRAG, salt2);
    const pending = requireHostedPassword({ encryption: { enabled: true, probe } });
    const field = await input();
    fireEvent.change(field, { target: { value: 'pw-2' } });
    fireEvent.click(unlock());
    await pending;
    expect(getSessionKey(salt2)).not.toBeNull();
    expect(getSessionKey(SALT)).toBeNull();
  });
  it('a right password with the wrong fragment is a wrong password (both halves are the key)', async () => {
    clearSessionKeys();
    const otherFrag = randomBytes(FRAGMENT_BYTES);
    const probe = await probeFor('richtig-2027', otherFrag, SALT);
    const pending = requireHostedPassword({ encryption: { enabled: true, probe } });
    const field = await input();
    fireEvent.change(field, { target: { value: 'richtig-2027' } });
    fireEvent.click(unlock());
    await waitFor(() => {
      if (!/Wrong password/i.test(root()?.textContent ?? '')) throw new Error('no error yet');
    });
    expect(await settled(pending)).toBe(false);
    expect(getSessionKey(SALT)).toBeNull();
    // Leave the page clean for the next test: unlock with the matching probe is
    // impossible here (the page holds FRAG), so unmount by resolving nothing —
    // the overlay is torn down with the test document.
    document.querySelector('#rv-password-gate-root')?.remove();
  });

});
