// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * terms-gate.test.tsx — plan-2209 §9.3: the pre-boot terms dialog.
 *
 * The build define is `off` under vitest (termsGateMode → isTest), so every
 * case passes the mode explicitly. Chromium under Playwright reports
 * `navigator.webdriver === true`; the cases that need the dialog force it to
 * false on the instance and restore it afterwards.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  requireTermsConsent, resetTermsGateForTests, TERMS_GATE_ROOT_ID,
} from '../src/core/hmi/terms-gate';
import {
  DEMO_TERMS_VERSION, DEVELOPER_TERMS_VERSION, hasTermsConsent, revokeTermsConsent,
} from '../src/core/hmi/terms-consent-store';
import { TERMS_CONSENT_KEY, readTermsConsent } from '../src/core/hmi/rv-storage-keys';
import welcomeModalSource from '../src/core/hmi/WelcomeModal.tsx?raw';

/** Override a navigator getter on the instance (shadows the prototype getter). */
function setNavigator<K extends 'webdriver'>(key: K, value: Navigator[K]): void {
  Object.defineProperty(navigator, key, { configurable: true, get: () => value });
}
function restoreNavigator(): void {
  delete (navigator as unknown as Record<string, unknown>).webdriver;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="rv-terms-gate"]');
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** Track whether a promise settled, without awaiting it. */
function track(p: Promise<void>): { settled: () => boolean } {
  let done = false;
  void p.then(() => { done = true; });
  return { settled: () => done };
}

beforeEach(() => {
  revokeTermsConsent();
  setNavigator('webdriver', false);
});

afterEach(async () => {
  resetTermsGateForTests();
  // An accepted dialog unmounts one tick later; never let it leak into the next case.
  await waitFor(() => document.getElementById(TERMS_GATE_ROOT_ID) === null);
  revokeTermsConsent();
  restoreNavigator();
});

describe('requireTermsConsent (plan-2209 §9.3)', () => {
  it('mode off resolves at once and shows nothing', async () => {
    await requireTermsConsent({ mode: 'off' });
    expect(document.getElementById(TERMS_GATE_ROOT_ID)).toBeNull();
  });

  it('the build define is off under vitest, so the default call shows nothing', async () => {
    await requireTermsConsent();
    expect(document.getElementById(TERMS_GATE_ROOT_ID)).toBeNull();
  });

  it('demo without consent: blocking dialog, promise pending, accessible labels', async () => {
    const run = track(requireTermsConsent({ mode: 'demo' }));
    const d = await waitFor(dialog);
    await settle();
    expect(run.settled()).toBe(false);
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(d.getAttribute('aria-labelledby')!);
    const desc = document.getElementById(d.getAttribute('aria-describedby')!);
    expect(title?.textContent).toBe('realvirtual public demo');
    expect(desc?.textContent).toContain('for evaluation and non-commercial use only');
    expect(desc?.textContent).toContain('No automated bulk use');
    expect(desc?.textContent).toContain('realvirtual CONNECT (MCP)');
    expect(desc?.textContent).toContain('no embedding in your own commercial offering');
    expect(desc?.textContent).toContain('No support and no availability commitment');
    expect(desc?.textContent).toContain('liability is excluded to the extent permitted by law');
    expect(desc?.textContent).not.toContain('share links');
    expect(document.getElementById(TERMS_GATE_ROOT_ID)!.style.zIndex).toBe('30000');
    // Focus is inside the dialog.
    expect(d.contains(document.activeElement)).toBe(true);

    const link = byTestId('rv-terms-gate-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://realvirtual.io/en/terms/#part-b');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(byTestId('rv-terms-gate-accept')!.textContent).toBe('Accept and start demo');
    expect(byTestId('rv-terms-gate-not-now')!.textContent).toBe('Not now');
    expect(byTestId('rv-terms-gate-version')!.textContent).toBe(`Terms version ${DEMO_TERMS_VERSION}`);
    // Tab order: link → accept → not now.
    const focusables = Array.from(d.querySelectorAll('a[href], button'));
    expect(focusables.map((el) => el.getAttribute('data-testid'))).toEqual([
      'rv-terms-gate-link', 'rv-terms-gate-accept', 'rv-terms-gate-not-now',
    ]);
    expect(hasTermsConsent('demo')).toBe(false);
  });

  it('Accept resolves, stores the current version and removes the dialog', async () => {
    const p = requireTermsConsent({ mode: 'demo' });
    await waitFor(dialog);
    byTestId('rv-terms-gate-accept')!.click();
    await p;
    expect(hasTermsConsent('demo')).toBe(true);
    const saved = JSON.parse(readTermsConsent()!);
    expect(saved.demo).toMatchObject({ mode: 'demo', version: DEMO_TERMS_VERSION, locale: 'en' });
    await waitFor(() => document.getElementById(TERMS_GATE_ROOT_ID) === null);
    // The page behind the dialog is no longer inert.
    expect(document.querySelectorAll('body > [inert]').length).toBe(0);
    // A second boot asks nothing.
    await requireTermsConsent({ mode: 'demo' });
    expect(document.getElementById(TERMS_GATE_ROOT_ID)).toBeNull();
  });

  it('ESC keeps the dialog open and never counts as consent', async () => {
    const run = track(requireTermsConsent({ mode: 'demo' }));
    const d = await waitFor(dialog);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    (document.activeElement ?? d).dispatchEvent(esc);
    await settle();
    expect(esc.defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(run.settled()).toBe(false);
    expect(hasTermsConsent('demo')).toBe(false);
  });

  it('Not now shows the info view with a link and Back; the promise stays pending', async () => {
    const run = track(requireTermsConsent({ mode: 'demo' }));
    await waitFor(dialog);
    byTestId('rv-terms-gate-not-now')!.click();
    const d = await waitFor(() => (dialog()?.dataset.view === 'info' ? dialog() : null));
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent)
      .toBe('The demo needs your consent');
    expect((byTestId('rv-terms-gate-info-link') as HTMLAnchorElement).href).toBe('https://realvirtual.io/');
    expect(byTestId('rv-terms-gate-accept')).toBeNull();
    await settle();
    expect(run.settled()).toBe(false);
    expect(hasTermsConsent('demo')).toBe(false);
    expect(readTermsConsent()).toBeNull();

    byTestId('rv-terms-gate-back')!.click();
    await waitFor(() => byTestId('rv-terms-gate-accept'));
    expect(run.settled()).toBe(false);
  });

  it('navigator.webdriver === true resolves at once, stores nothing and leaves storage unchanged', async () => {
    setNavigator('webdriver', true);
    localStorage.setItem('rv-unrelated-probe', 'x');
    const before = { ...localStorage } as Record<string, string>;
    const beforeSession = { ...sessionStorage } as Record<string, string>;
    await requireTermsConsent({ mode: 'demo' });
    await requireTermsConsent({ mode: 'developer' });
    expect(document.getElementById(TERMS_GATE_ROOT_ID)).toBeNull();
    expect(localStorage.getItem(TERMS_CONSENT_KEY)).toBeNull();
    expect({ ...localStorage }).toEqual(before);
    expect({ ...sessionStorage }).toEqual(beforeSession);
    expect(hasTermsConsent('demo')).toBe(false);
    localStorage.removeItem('rv-unrelated-probe');
  });

  it('developer mode shows the licence texts and stores the developer consent only', async () => {
    const p = requireTermsConsent({ mode: 'developer' });
    const d = await waitFor(dialog);
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent)
      .toBe('realvirtual Commercial — licence terms');
    expect(d.textContent).toContain('Development licence');
    expect(d.textContent).toContain('deployment licence');
    expect(d.textContent).toContain('Section 13.8');
    expect(d.textContent).toContain('confidential');
    expect(byTestId('rv-terms-gate-accept')!.textContent).toBe('Accept licence terms');
    expect(byTestId('rv-terms-gate-version')!.textContent).toBe(`Terms version ${DEVELOPER_TERMS_VERSION}`);
    byTestId('rv-terms-gate-accept')!.click();
    await p;
    expect(hasTermsConsent('developer')).toBe(true);
    expect(hasTermsConsent('demo')).toBe(false);
  });

  it('the gate never touches the URL', async () => {
    const before = window.location.href;
    const p = requireTermsConsent({ mode: 'demo' });
    await waitFor(dialog);
    byTestId('rv-terms-gate-accept')!.click();
    await p;
    expect(window.location.href).toBe(before);
  });
});

describe('WelcomeModal in the demo build (plan-2209)', () => {
  it('a current demo terms consent counts as the welcome accept, folded away outside the demo', () => {
    expect(welcomeModalSource).toMatch(/if \(__RV_TERMS_GATE__ === 'demo' && hasTermsConsent\('demo'\)\) return true;/);
  });
});
