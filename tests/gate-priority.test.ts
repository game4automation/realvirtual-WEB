// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.6c (integration half) — gate priority.
 *
 * On a password deploy nothing project-related may leave the tab before the
 * password is accepted — even though the consent question no longer blocks the
 * boot — and the consent dialog must not cover the password overlay. The boot
 * runs its gates through `runBootGates` (main.ts), so that function is driven
 * here with the REAL password gate and the REAL consent dialog; the early starts
 * are the real discovery start against a spying fetch.
 *
 * The network half with real HTML preloads is `e2e/hosted-preload.spec.ts`.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import {
  encryptGlb, bytesToBase64Url, randomBytes, FRAGMENT_BYTES, PROBE_PLAINTEXT, PROBE_INFO,
} from '../src/core/persistence/rv-crypto-utils';
import { initFragmentSecret, requireHostedPassword } from '../src/core/hmi/password-gate';
import { clearSessionKeys } from '../src/core/persistence/rv-served-bytes';
import { requireAnalyticsConsent } from '../src/core/hmi/consent-gate';
import { getAppConfig, setAppConfig } from '../src/core/rv-app-config';
import { startNonBlockingConsent } from '../src/core/rv-consent-boot';
import { runBootGates } from '../src/core/rv-boot-gates';
import { startBootDiscovery } from '../src/core/project/rv-boot-discovery';

const FRAG = randomBytes(FRAGMENT_BYTES);
const SALT = randomBytes(16);
const PASSWORD = 'richtig-598';

async function probeFor(password: string): Promise<string> {
  const env = new Uint8Array(await encryptGlb(new TextEncoder().encode(PROBE_PLAINTEXT), password, FRAG, {
    salt: SALT, iterations: 1000, hkdfInfo: PROBE_INFO,
  }));
  let bin = '';
  for (const b of env) bin += String.fromCharCode(b);
  return btoa(bin);
}

const passwordRoot = () => document.querySelector('#rv-password-gate-root');
const consentRoot = () => document.querySelector('#rv-consent-gate-root');
const flush = () => new Promise<void>((r) => setTimeout(r, 30));

const savedConfig = getAppConfig();

beforeAll(() => {
  window.location.hash = '#k=' + bytesToBase64Url(FRAG);
  initFragmentSecret();
});

afterEach(() => {
  setAppConfig(savedConfig);
  document.querySelector('#rv-consent-gate-root')?.remove();
  try { localStorage.removeItem('rv-analytics-consent'); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
});

describe('runBootGates — password first, then consent, then the network', () => {
  it('on a password deploy: no project request and no consent dialog until the password is accepted', async () => {
    clearSessionKeys();
    // A tracker IS configured and not consented — the consent dialog would show.
    setAppConfig({ ...savedConfig, analytics: { googleAnalyticsId: 'G-TEST598' } });
    const probe = await probeFor(PASSWORD);
    const requests: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => { requests.push(String(url)); return new Response('{}', { status: 404 }); }) as typeof fetch;
    const manifestReads: string[] = [];

    const order: string[] = [];
    const booting = runBootGates({
      requirePassword: async () => { await requireHostedPassword({ encryption: { enabled: true, probe } }); order.push('password'); },
      startConsent: () => { order.push('consent'); return startNonBlockingConsent({ requireConsent: () => requireAnalyticsConsent(''), initAnalytics: () => {}, track: () => {} }); },
      startEarly: () => {
        order.push('early');
        return startBootDiscovery({
          dev: true, baseUrl: '/', mayHaveGatewayOrigin: true, fetchImpl,
          readDemoManifest: async () => { manifestReads.push('demo-realvirtual/project.json'); return null; },
        });
      },
    });

    const field = await waitFor(() => {
      const el = document.querySelector('#rv-password-gate-root input') as HTMLInputElement | null;
      if (!el) throw new Error('password gate not mounted yet');
      return el;
    });
    await flush();
    // The password overlay is up — and NOTHING else happened.
    expect(passwordRoot()).not.toBeNull();
    expect(consentRoot()).toBeNull();
    expect(requests).toEqual([]);
    expect(manifestReads).toEqual([]);
    expect(order).toEqual([]);

    fireEvent.change(field, { target: { value: PASSWORD } });
    const unlock = Array.from(document.querySelectorAll('#rv-password-gate-root button'))
      .find((b) => /unlock/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(unlock);
    const { consent } = await booting;

    // Order: password → consent → early, and the boot did NOT wait for the consent answer.
    expect(order).toEqual(['password', 'consent', 'early']);
    await waitFor(() => { if (consentRoot() === null) throw new Error('consent dialog not mounted yet'); });
    expect(manifestReads).toEqual(['demo-realvirtual/project.json']);
    expect(requests.some((u) => u.endsWith('models.json'))).toBe(true);
    let answered = false;
    void consent.outcome.then(() => { answered = true; });
    await flush();
    expect(answered).toBe(false); // the dialog is still open — the boot is already past it
  });

  it('on an unencrypted deploy the gates pass at once and the early starts run immediately', async () => {
    clearSessionKeys();
    const order: string[] = [];
    await runBootGates({
      requirePassword: async () => { await requireHostedPassword({}); order.push('password'); },
      startConsent: () => { order.push('consent'); return startNonBlockingConsent({ requireConsent: async () => 'not-configured', initAnalytics: () => {}, track: () => {} }); },
      startEarly: () => { order.push('early'); },
    });
    expect(order).toEqual(['password', 'consent', 'early']);
    expect(passwordRoot()).toBeNull();
  });
});
