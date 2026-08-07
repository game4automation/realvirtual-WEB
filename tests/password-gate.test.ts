// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * password-gate.test.ts — plan-267 Phase 2 runtime gate. Drives the real gate
 * overlay in headless Chromium: fragment parse + hash scrubbing, pass-through of
 * unencrypted data, and the full unlock flow (wrong password stays open, correct
 * password decrypts). This is the end-to-end proof that an encrypted model is
 * only decrypted after the correct password — the browser half of the golden
 * contract the Node pipeline encrypts against.
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import { encryptGlb, bytesToBase64Url, randomBytes, FRAGMENT_BYTES } from '../src/core/persistence/rv-crypto-utils';
import { initFragmentSecret, getFragmentSecret, decryptModelData } from '../src/core/hmi/password-gate';

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function decode(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

const FRAG = randomBytes(FRAGMENT_BYTES);

describe('password gate', () => {
  it('passes through unencrypted data untouched', async () => {
    const plain = textBytes('glTF plain bytes').buffer;
    const out = await decryptModelData(plain as ArrayBuffer);
    expect(out).toBe(plain);
  });

  it('parses #k= and scrubs it from the address bar (F6)', () => {
    window.location.hash = '#k=' + bytesToBase64Url(FRAG) + '&model=demo';
    initFragmentSecret();
    const frag = getFragmentSecret();
    expect(frag).not.toBeNull();
    expect(Array.from(frag!)).toEqual(Array.from(FRAG));
    // k= is gone, other hash params survive.
    expect(window.location.hash).not.toContain('k=');
    expect(window.location.hash).toContain('model=demo');
  });

  it('decrypts only after the correct password (wrong password stays open)', async () => {
    // Uses the fragment captured by the previous test (module singleton).
    const cipher = await encryptGlb(textBytes('SECRET-GLB-GEOMETRY'), 'richtig-2027', getFragmentSecret()!, {
      iterations: 1000,
    });

    const pending = decryptModelData(cipher);

    const input = await waitFor(() => {
      const el = document.querySelector('#rv-password-gate-root input') as HTMLInputElement | null;
      if (!el) throw new Error('gate input not mounted yet');
      return el;
    });
    // The gate has two buttons (show-password eye + Unlock) — pick Unlock by text.
    const button = () =>
      Array.from(document.querySelectorAll('#rv-password-gate-root button')).find((b) =>
        /unlock/i.test(b.textContent ?? ''),
      ) as HTMLButtonElement;

    // Wrong password → error shown, gate stays open, promise unresolved.
    fireEvent.change(input, { target: { value: 'falsch' } });
    fireEvent.click(button());
    await waitFor(() => {
      const root = document.querySelector('#rv-password-gate-root');
      if (!root || !/Wrong password/i.test(root.textContent ?? '')) throw new Error('no error yet');
    });

    // Correct password → resolves with the plaintext.
    fireEvent.change(input, { target: { value: 'richtig-2027' } });
    fireEvent.click(button());
    const out = await pending;
    expect(decode(out)).toBe('SECRET-GLB-GEOMETRY');
  });
});
