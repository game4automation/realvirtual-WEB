// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-560 §9.7 — the trust banner for a link opened with its password: a
 * notice, no Activate/Revoke (there is no trust-store record, and a reload
 * would lose the scrubbed `#k=`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

import { CommissioningTrustBanner } from '../src/core/hmi/CommissioningTrustBanner';
import { activateContext, _resetStore } from '../src/core/hmi/ui-context-store';
import { modeContext } from '../src/core/rv-mode-manager';
import { setModelProvenance, resetModelProvenance } from '../src/core/rv-model-provenance';
import {
  SHARE_TRUST_KEY, rememberShareTrust, shareTrustKeyForUrl,
} from '../src/core/share/rv-share-trust-store';

const URL_ = 'https://files.example.org/model.rve.glb';
const DIGEST = 'a'.repeat(64);

beforeEach(() => {
  localStorage.clear();
  resetModelProvenance();
  _resetStore();
});

afterEach(() => {
  cleanup();
  resetModelProvenance();
  _resetStore();
  localStorage.clear();
});

describe('CommissioningTrustBanner — share-encrypted (plan-560)', () => {
  it('shows the session notice without Revoke or Activate, and leaves the trust store alone', () => {
    const key = shareTrustKeyForUrl(URL_);
    rememberShareTrust(key, DIGEST);
    const stored = localStorage.getItem(SHARE_TRUST_KEY);
    expect(stored).not.toBeNull();

    setModelProvenance({
      trusted: true, source: 'share-encrypted', trustRecordKey: key, digest: DIGEST, sourceOrigin: 'files.example.org',
    });
    const onReload = vi.fn();
    activateContext(modeContext('commissioning'));
    render(createElement(CommissioningTrustBanner, { onReload }));

    expect(screen.getByTestId('commissioning-trust-encrypted-notice').textContent)
      .toBe('Opened with password — live connections enabled for this session.');
    expect(screen.queryByTestId('commissioning-trust-revoke')).toBeNull();
    expect(screen.queryByTestId('commissioning-trust-activate')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(localStorage.getItem(SHARE_TRUST_KEY)).toBe(stored);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('a trusted plain share still offers Revoke (unchanged)', () => {
    setModelProvenance({
      trusted: true, source: 'own-url', trustRecordKey: shareTrustKeyForUrl(URL_), digest: DIGEST,
    });
    activateContext(modeContext('commissioning'));
    render(createElement(CommissioningTrustBanner, { onReload: vi.fn() }));
    expect(screen.getByTestId('commissioning-trust-revoke')).toBeTruthy();
    expect(screen.queryByTestId('commissioning-trust-encrypted-notice')).toBeNull();
  });
});
