// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * hosted-boot-gate-incomplete.test.tsx — plan-759 §9.3, the link without `#k=`.
 * Own file because the fragment is parsed once per page (module singleton), so
 * the "missing" state cannot be produced after another test parsed one.
 */

import { describe, it, expect } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { encryptGlb, randomBytes, FRAGMENT_BYTES, PROBE_PLAINTEXT, PROBE_INFO } from '../src/core/persistence/rv-crypto-utils';
import { initFragmentSecret, getFragmentSecret, requireHostedPassword } from '../src/core/hmi/password-gate';

describe('requireHostedPassword without #k=', () => {
  it('shows the terminal "incomplete link" card and never resolves', async () => {
    window.location.hash = '';
    initFragmentSecret();
    expect(getFragmentSecret()).toBeNull();

    const env = new Uint8Array(await encryptGlb(
      new TextEncoder().encode(PROBE_PLAINTEXT), 'pw', randomBytes(FRAGMENT_BYTES),
      { salt: randomBytes(16), iterations: 1000, hkdfInfo: PROBE_INFO },
    ));
    let bin = '';
    for (const b of env) bin += String.fromCharCode(b);
    const pending = requireHostedPassword({ encryption: { enabled: true, probe: btoa(bin) } });

    await waitFor(() => {
      const root = document.querySelector('#rv-password-gate-root');
      if (!root || !/Incomplete link/i.test(root.textContent ?? '')) throw new Error('card not shown yet');
    });
    expect(document.querySelector('#rv-password-gate-root input')).toBeNull();
    const resolved = await Promise.race([pending.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 100))]);
    expect(resolved).toBe(false);
  });
});
