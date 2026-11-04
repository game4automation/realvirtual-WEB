// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEMO_TERMS_VERSION, DEVELOPER_TERMS_VERSION,
  grantTermsConsent, hasTermsConsent, revokeTermsConsent,
} from '../src/core/hmi/terms-consent-store';
import {
  ALL_RV_STORAGE_KEYS, TERMS_CONSENT_KEY, clearAllRVStorage,
  clearTermsConsent, readTermsConsent, writeTermsConsent,
} from '../src/core/hmi/rv-storage-keys';

beforeEach(() => revokeTermsConsent());
afterEach(() => { vi.restoreAllMocks(); revokeTermsConsent(); });

describe('versioned terms consent', () => {
  it('starts closed and persists independent modes with metadata', () => {
    expect(hasTermsConsent('demo')).toBe(false);
    expect(hasTermsConsent('developer')).toBe(false);
    grantTermsConsent('demo', 'de');
    expect(hasTermsConsent('demo')).toBe(true);
    expect(hasTermsConsent('developer')).toBe(false);
    grantTermsConsent('developer', 'en');
    const saved = JSON.parse(readTermsConsent()!);
    expect(saved.demo).toMatchObject({ mode: 'demo', version: DEMO_TERMS_VERSION, locale: 'de' });
    expect(saved.developer).toMatchObject({ mode: 'developer', version: DEVELOPER_TERMS_VERSION, locale: 'en' });
    expect(Number.isFinite(Date.parse(saved.demo.acceptedAt))).toBe(true);
    expect(hasTermsConsent('demo')).toBe(true);
    expect(hasTermsConsent('developer')).toBe(true);
  });

  for (const mode of ['demo', 'developer'] as const) {
    it(`${mode}: accepts only a valid current record`, () => {
      const record = { mode, version: mode === 'demo' ? DEMO_TERMS_VERSION : DEVELOPER_TERMS_VERSION, acceptedAt: new Date().toISOString(), locale: 'en' };
      writeTermsConsent(JSON.stringify({ [mode]: record }));
      expect(hasTermsConsent(mode)).toBe(true);
      for (const invalid of [null, {}, { ...record, version: 'old' }, { ...record, mode: 'other' },
        { ...record, acceptedAt: 'invalid' }, { ...record, locale: 'fr' }]) {
        writeTermsConsent(JSON.stringify({ [mode]: invalid }));
        expect(hasTermsConsent(mode)).toBe(false);
      }
    });
  }

  it('fails closed for malformed JSON and invalid root values', () => {
    for (const raw of ['bad json', 'null', '[]', 'true', '42']) {
      writeTermsConsent(raw);
      expect(hasTermsConsent('demo')).toBe(false);
    }
  });

  it('survives a throwing localStorage getter and grants only the current session', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
    expect(readTermsConsent()).toBeNull();
    expect(writeTermsConsent('{}')).toBe(false);
    expect(() => clearTermsConsent()).not.toThrow();
    expect(hasTermsConsent('demo')).toBe(false);
    grantTermsConsent('demo', 'en');
    expect(hasTermsConsent('demo')).toBe(true);
    expect(hasTermsConsent('developer')).toBe(false);
    revokeTermsConsent();
    expect(hasTermsConsent('demo')).toBe(false);
  });

  it('falls back when storage methods throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('read'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('write'); });
    expect(hasTermsConsent('developer')).toBe(false);
    grantTermsConsent('developer', 'de');
    expect(hasTermsConsent('developer')).toBe(true);
  });

  it('revokes both modes and includes the key in the actual reset', () => {
    expect(ALL_RV_STORAGE_KEYS).toContain(TERMS_CONSENT_KEY);
    grantTermsConsent('demo', 'en');
    grantTermsConsent('developer', 'de');
    clearAllRVStorage();
    expect(hasTermsConsent('demo')).toBe(false);
    expect(hasTermsConsent('developer')).toBe(false);
    grantTermsConsent('demo', 'en');
    revokeTermsConsent();
    expect(readTermsConsent()).toBeNull();
    expect(hasTermsConsent('demo')).toBe(false);
  });
});
