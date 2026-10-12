// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-560 §9.8 — the Node→browser format boundary, automated.
 *
 * `fixtures/share-encrypted-sample.rve.glb` was written ONCE by the share CLI
 * (`RV_SHARE_PASSWORD=<FIXTURE_PASSWORD> npm run share:encrypt --
 * tests/fixtures/chain-vertical-open.glb --out tests/fixtures/share-encrypted-sample.rve.glb`)
 * from the checked-in source GLB. This browser test opens it with the BROWSER
 * implementation — once with the primitives, once through the real overlay —
 * and compares byte for byte with the source. The password and fragment below
 * are test secrets of this fixture only.
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import {
  deriveMasterKey, decryptEnvelope, parseEnvelopeHeader, base64UrlToBytes, DEFAULT_ITERATIONS,
} from '../src/core/persistence/rv-crypto-utils';
import { initFragmentSecret, decryptModelData } from '../src/core/hmi/password-gate';
import envelopeUrl from './fixtures/share-encrypted-sample.rve.glb?url';
import sourceUrl from './fixtures/chain-vertical-open.glb?url';

const FIXTURE_PASSWORD = 'share-fixture-pass-2026';
const FIXTURE_FRAGMENT = 'BYIz8qLg_IpEfUG8ZfyxTEYrdaJvGC7ApnQAsCr56ew';

async function bytesOf(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  expect(resp.ok).toBe(true);
  return resp.arrayBuffer();
}

describe('share CLI fixture opens in the browser (plan-560 §9.8)', () => {
  it('derives + decrypts with the browser primitives, byte-identical to the source GLB', async () => {
    const [envelope, source] = await Promise.all([bytesOf(envelopeUrl), bytesOf(sourceUrl)]);
    const header = await parseEnvelopeHeader(envelope);
    expect(header.iterations).toBe(DEFAULT_ITERATIONS);
    expect(header.chunkSize).toBe(16 * 1024 * 1024);
    const key = await deriveMasterKey(FIXTURE_PASSWORD, base64UrlToBytes(FIXTURE_FRAGMENT), header.salt, header.iterations);
    const plain = await decryptEnvelope(envelope, key);
    expect(new Uint8Array(plain)).toEqual(new Uint8Array(source));
  });

  it('opens through the real password overlay (cancellable share path)', async () => {
    const [envelope, source] = await Promise.all([bytesOf(envelopeUrl), bytesOf(sourceUrl)]);
    window.location.hash = `#k=${FIXTURE_FRAGMENT}`;
    initFragmentSecret();

    const pending = decryptModelData(envelope, { cancellable: true });
    const input = await waitFor(() => {
      const el = document.querySelector('#rv-password-gate-root input') as HTMLInputElement | null;
      if (!el) throw new Error('gate not mounted');
      return el;
    });
    fireEvent.change(input, { target: { value: FIXTURE_PASSWORD } });
    const open = Array.from(document.querySelectorAll('#rv-password-gate-root button'))
      .find((b) => /^open$/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(open);
    expect(new Uint8Array(await pending)).toEqual(new Uint8Array(source));
  });
});
