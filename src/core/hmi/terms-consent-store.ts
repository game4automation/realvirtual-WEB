// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Versioned, independent terms acknowledgements for the demo and developer workspace. */
import { clearTermsConsent, readTermsConsent, writeTermsConsent } from './rv-storage-keys';

export type TermsGateMode = 'off' | 'demo' | 'developer';
type ConsentMode = Exclude<TermsGateMode, 'off'>;
export const DEMO_TERMS_VERSION = '2026-11-04';
export const DEVELOPER_TERMS_VERSION = '2026-11-02';

export interface TermsConsentRecord {
  mode: ConsentMode;
  version: string;
  acceptedAt: string;
  locale: 'de' | 'en';
}

type ConsentRecords = Partial<Record<ConsentMode, TermsConsentRecord>>;
let sessionGrants: ConsentRecords = {};

function readRecords(): ConsentRecords {
  try {
    const value: unknown = JSON.parse(readTermsConsent() ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ConsentRecords : {};
  } catch { return {}; }
}

/** Fail closed on malformed, missing or outdated consent; a blocked write lasts this session. */
export function hasTermsConsent(mode: ConsentMode): boolean {
  const record = sessionGrants[mode] ?? readRecords()[mode];
  return record?.mode === mode
    && record.version === (mode === 'demo' ? DEMO_TERMS_VERSION : DEVELOPER_TERMS_VERSION)
    && typeof record.acceptedAt === 'string' && Number.isFinite(Date.parse(record.acceptedAt))
    && (record.locale === 'de' || record.locale === 'en');
}

/** Record only an explicit acknowledgement, preserving the other mode's consent. */
export function grantTermsConsent(mode: ConsentMode, locale: 'de' | 'en'): void {
  const record: TermsConsentRecord = {
    mode, locale,
    version: mode === 'demo' ? DEMO_TERMS_VERSION : DEVELOPER_TERMS_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  const records = { ...readRecords(), ...sessionGrants, [mode]: record };
  if (writeTermsConsent(JSON.stringify(records))) sessionGrants = {};
  else sessionGrants[mode] = record;
}

/** Withdraw both acknowledgements from storage and the session fallback. */
export function revokeTermsConsent(): void {
  sessionGrants = {};
  clearTermsConsent();
}
